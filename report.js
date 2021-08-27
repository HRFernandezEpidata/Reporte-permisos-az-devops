const { exec } = require("child_process");
const pdf = require("pdf-creator-node");
const fs = require('fs');

const timeStart = new Date()

const reportConfig = require('./reportConfiguration.json');

if (reportConfig.organizationName == '')
    throw (`Error: La clave "organizationName" del archivo "reportConfiguration.json" esta vacio.`);

const orgName = reportConfig.organizationName;
const urlOrganization = 'https://dev.azure.com/' + orgName

const allUsers = [];

const cmdGetAllOrganizationGroups = `az devops security group list --scope organization --org ${urlOrganization}`;
console.log('Obteniendo los usuarios de la organización...');
exec(cmdGetAllOrganizationGroups, async (error, stdout, stderr) => {
    if (error) {
        console.log(`error: ${error.message}`);
        return;
    }
    else {
        const groups = JSON.parse(stdout).graphGroups;

        const projectGroups = Object.values(groups)                     //  We filter and we are left with only groups 
        .filter(g => !g.principalName.includes(`[${orgName}]`))         //  of projects only groups of projects
        .filter(g => !g.principalName.includes('[TEAM FOUNDATION]'));   //
        
        const projects = [];

        for (const group of projectGroups) {
            const principalName = group.principalName;
            const projectName = principalName.substring(1, principalName.indexOf(']'));
            
            const project = projects.find(e => e.name == projectName);
            
            if (project) {
                project.groups.push({ 
                    name: group.principalName,
                    descriptor: group.descriptor,
                });
            }
            else {
                const idProject = group.domain.split('TeamProject/')[1];
                projects.push({
                    name: projectName,
                    id: idProject,
                    groups: [
                        { 
                            name: group.principalName,
                            descriptor: group.descriptor
                        }
                    ]
                });
            }
        }
        
        const promisesGetProjectUsers = [];
        for (const project of projects) 
            promisesGetProjectUsers.push(getProjectUsers(project));

        await Promise.all(promisesGetProjectUsers);
        
        projects.forEach(project => {
            project.users.forEach(user => {
                const containUser = allUsers.find(u => u.mail == user.mail);
                if (!containUser)
                    allUsers.push(user);
            });
        });

        console.log(`Total de usuarios de la organización: ${allUsers.length}`);

        //Get Organization permissions
        console.log('Obteniendo permisos a nivel organización de los usuarios...');
        const promisesGetOrganizationPermissions = [];
        const orgPermissions = reportConfig.report.organizationPermissions;
        for (const user of allUsers) 
            promisesGetOrganizationPermissions.push(getOrganizationPermissions(user, orgPermissions));
        await Promise.all(promisesGetOrganizationPermissions);

        //Get project permissions
        console.log('Obteniendo permisos a nivel proyecto de los usuarios...');
        const projPermissions = reportConfig.report.projectPermissions;
        const promisesGetProjectPermissions = [];
        for (const project of projects) 
            promisesGetProjectPermissions.push(getProjectPermissions(project, projPermissions));
        await Promise.all(promisesGetProjectPermissions);


        //Report generation
        console.log('Generating report...');
        
        const templateReport = fs.readFileSync("templateReport.html", "utf8");

        const options = reportConfig.report.options;
        options.header.contents = `<div style="text-align: right;">${"Generado: " + new Date(Date.now()).toString()}</div>`;
        options.footer.contents = '<div style="text-align:center;margin-top:40px;">{{page}}/{{pages}}</div>';

        const document = {
            html: templateReport,
            data: {
                organizationName: orgName,
                users: allUsers
            },
            path: `./Reporte de permisos (${orgName}).pdf`,
            type: ""
        }
        
        pdf.create(document, options)
        .then((res) => {
            console.log('Report generated: ' + res.filename);
            const timeStop = new Date();
            const timeTotalSeconds = (timeStop - timeStart) / 1000;
            const minutes = Math.floor(timeTotalSeconds / 60);
            const seconds = Math.round(timeTotalSeconds - minutes * 60);
            console.log(`Execution Time: ${minutes}m ${seconds}s`);
        })
        .catch((error) => {
            console.error(error);
        });

        fs.writeFileSync('users.json', JSON.stringify(allUsers));
    }
});

async function getProjectUsers(project) {
    const projectUsers = [];
    return new Promise(async (resolve, reject) => {
        for (const group of project.groups) {
            const cmd = `az devops security group membership list --id ${group.descriptor} --org ${urlOrganization} --relationship members`;
            const groupUsers = await new Promise ((resolve, reject) => { 
                exec (cmd, (error, stdout, stderr) => { 
                    if (error) { 
                        console.warn(error); 
                    }
                    const data = JSON.parse(stdout);
                    const users = Object.values(data)
                    .filter(m => m.subjectKind == 'user')
                    .filter(m => m.mailAddress != '')
                    .map(m => {
                        return {
                            name: m.displayName,
                            mail: m.mailAddress,
                            permissions: {
                                organization: [],
                                projects: []
                            }
                        }
                    });
                    resolve(users); 
                }); 
            });
    
            groupUsers.forEach(user => {
                const containUser = projectUsers.find(u => u.mail == user.mail);
                if (!containUser)
                    projectUsers.push(user);
            });
        }
        project.users = projectUsers;
        resolve();
    });
}

async function getOrganizationPermissions(user, permissions) {
    return new Promise(async (resolve, reject) => {
        for (const p of permissions) {
            const permissions = await getPermissions(p.namespaceId, user.mail, p.token);
            user.permissions.organization.push({
                name: p.name,
                values: permissions
            });
        }
        resolve();
    });
}

async function getProjectPermissions(project, permissions) {
    return new Promise(async (resolve, reject) => {
        for (const p of permissions) {
            const groupId = project.groups[0].descriptor;
            let token = p.token.replace('{projectId}', project.id);
            token = await getPermissionToken(p.namespaceId, groupId, token);
            if (token != undefined) {
                const projectUsers = allUsers.filter(u => project.users.map(u=>u.mail).includes(u.mail));
                for (const user of projectUsers) {
                    const permissions = await getPermissions(p.namespaceId, user.mail, token);
                    const projectPermissions = user.permissions.projects.find(p => p.name == project.name);
                    if (projectPermissions) {
                        projectPermissions.permissions.push({
                            name: p.name,
                            values: permissions
                        });
                    }
                    else {
                        user.permissions.projects.push({
                            name: project.name,
                            nameDisplay: `[${project.name}]/${user.mail}`,
                            permissions: [{
                                name: p.name,
                                values: permissions
                            }]
                        });
                    }
                }
            }
        }
        resolve();
    });
}

async function getPermissionToken(namespaceId, descriptor, tokenToFind) {
    const cmd = `az devops security permission list --id ${namespaceId} --subject ${descriptor} --org ${urlOrganization}`;
    const token = await new Promise ((resolve, reject) => { 
        exec (cmd, (error, stdout, stderr) => { 
            if (error) { 
                console.warn(error); 
            }

            const data = JSON.parse(stdout);
            const o = data.find(o => o.token.includes(tokenToFind));

            resolve(o == undefined ? undefined : o.token); 
        }); 
    });
    return token;
}

async function getPermissions(namespaceId, descriptor, token) {
    const cmd = `az devops security permission show --id ${namespaceId} --subject ${descriptor} --token ${token} --org ${urlOrganization}`;
    const permissions = await new Promise ((resolve, reject) => { 
        exec (cmd, (error, stdout, stderr) => { 
            if (error) { 
                console.warn(error); 
            }
            const data = JSON.parse(stdout);
            const permissions = Object.values(data[0].acesDictionary)[0].resolvedPermissions.map(p => {
                return {
                    name: p.displayName,
                    value: p.effectivePermission
                }
            });
            resolve(permissions); 
        }); 
    });
    return permissions;
}
