const vscode = require('vscode');
const child_process = require('child_process');
const axios = require('axios');
const path = require('path');

function activate(context) {
    console.log('Activating Auto Commit Extension...');

    let disposable = vscode.commands.registerCommand('tinieblasautocommit.autoCommit', async () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            vscode.window.showErrorMessage('No workspace folder detected.');
            return;
        }
        const workspacePath = workspaceFolders[0].uri.fsPath;

        try {
            const gitStatus = await runGitCommand('git status --porcelain', workspacePath);
            console.log("gitStatus: " + gitStatus);  // Muestra la salida del git status

            if (!gitStatus) {
                vscode.window.showErrorMessage('No git repository detected.');
                return;
            }

            const changes = classifyChanges(gitStatus);
            if (!changes) {
                vscode.window.showInformationMessage('No changes to commit.');
                return;
            }

            const { shortMessage, detailedMessage } = await generateDetailedCommitMessage(changes);

            // console.log('Mensaje de commit:', shortMessage, detailedMessage);  // Muestra los mensajes generados

            await runGitCommand(`git add .`, workspacePath);
            await runGitCommand(`git commit -m "${shortMessage}" -m "${detailedMessage}"`, workspacePath);

            vscode.window.showInformationMessage('Commit made successfully.');
        } catch (err) {
            vscode.window.showErrorMessage(`Error: ${err}`);
        }
    });

    context.subscriptions.push(disposable);
}

function deactivate() {}

async function runGitCommand(command, cwd) {
    return new Promise((resolve, reject) => {
        child_process.exec(command, { cwd }, (error, stdout, stderr) => {
            if (error) {
                reject(`Git error: ${error.message}`);
                return;
            }
            if (stderr) {
                reject(`Git stderr: ${stderr.trim()}`);
                return;
            }
            resolve(stdout.trim());
        });
    });
}

function classifyChanges(status) {
    const changes = {
        added: [],
        modified: [],
        deleted: []
    };

    status.split('\n').forEach(line => {
        const changeType = line.slice(0, 2).trim(); // Los dos primeros caracteres, eliminando espacios
        const filePath = line.slice(3);           // El resto es el nombre del archivo

        if (changeType === 'A') {
            changes.added.push(filePath);
        } else if (changeType === 'M') {
            changes.modified.push(filePath);
        } else if (changeType === 'D') {
            changes.deleted.push(filePath);
        }
    });

    // console.log('Clasificación de cambios:', changes);  // Muestra cómo se están clasificando los cambios
    return changes;
}



async function generateDetailedCommitMessage(changes) {
    // console.log('Archivos a considerar:', changes);  // Verifica los archivos que se están procesando

    try {
        const apiKey = vscode.workspace.getConfiguration().get('tinieblasautocommit.apiKey');
        if (!apiKey) {
            vscode.window.showErrorMessage('Por favor, configura tu clave API en la configuración de la extensión.');
            return { shortMessage: 'Actualización de proyecto', detailedMessage: 'Cambios generales en el proyecto.' };
        }

        // Combine all changed files
        const allChangedFiles = [
            ...changes.added,
            ...changes.modified,
            ...changes.deleted
        ];

        // Determine primary change type and focus files
        const changeTypes = [
            ...changes.added.map(() => 'add'),
            ...changes.modified.map(() => 'update'),
            ...changes.deleted.map(() => 'remove')
        ];
        const primaryChangeType = getMostFrequentChangeType(changeTypes);

        // Get top 2-3 most significant files
        const focusFiles = getMostSignificantFiles(allChangedFiles);

        // Determine change category
        const changeCategory = getChangeCategory(focusFiles);

        // Generate short message
        const emoji = getEmojiForChangeType(primaryChangeType);
        const shortMessage = `${emoji} ${changeCategory}: ${focusFiles.join(' y ')}`;

        // Generate detailed message
        const detailedMessage = await generateDetailedDescription(changes, focusFiles, changeCategory);

        return { 
            shortMessage: shortMessage.slice(0, 72), // Limit to reasonable length
            detailedMessage: detailedMessage 
        };
    } catch (error) {
        console.error('Commit message generation error:', error);
        return { 
            shortMessage: '🛠️ Actualización de proyecto', 
            detailedMessage: 'Se realizaron modificaciones generales en el proyecto.' 
        };
    }
}

function getMostSignificantFiles(files) {
    // Filter out common, less interesting files
    const significantFiles = files.filter(file => 
        !file.includes('node_modules/') && 
        !file.includes('.lock') && 
        !file.includes('.log')
    );

    // Sort by perceived significance (shorter paths, certain extensions)
    const prioritizedFiles = significantFiles.sort((a, b) => {
        const priorityExtensions = ['.py', '.js', '.ts', '.json', '.yml', '.yaml', '.gitignore'];
        
        const aExt = path.extname(a);
        const bExt = path.extname(b);
        
        const aIsPriority = priorityExtensions.includes(aExt);
        const bIsPriority = priorityExtensions.includes(bExt);
        
        if (aIsPriority && !bIsPriority) return -1;
        if (!aIsPriority && bIsPriority) return 1;
        
        return a.length - b.length;
    });

    // Return top 2-3 files, or all if fewer
    return prioritizedFiles.slice(0, 3).map(file => path.basename(file));
}

function getChangeCategory(files) {
    const fileTypes = files.map(file => path.extname(file).replace('.', ''));
    
    if (fileTypes.includes('gitignore')) return 'Configuración';
    if (fileTypes.includes('py')) return 'Mejora';
    if (fileTypes.includes('js') || fileTypes.includes('ts')) return 'Desarrollo';
    if (fileTypes.includes('json')) return 'Configuración';
    
    return 'Actualización';
}

function getMostFrequentChangeType(types) {
    const typeCount = types.reduce((acc, type) => {
        acc[type] = (acc[type] || 0) + 1;
        return acc;
    }, {});
    return Object.keys(typeCount).reduce((a, b) => typeCount[a] > typeCount[b] ? a : b);
}

function getEmojiForChangeType(type) {
    switch(type) {
        case 'add': return '✨';
        case 'update': return '🔧';
        case 'remove': return '🗑️';
        default: return '💡';
    }
}

async function generateDetailedDescription(changes, focusFiles, changeCategory) {
    try {
        const apiKey = vscode.workspace.getConfiguration().get('tinieblasautocommit.apiKey');
        
        const response = await axios.post(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=' + apiKey,
            {
                contents: [{
                    parts: [{
                        text: `Genera una descripción de commit detallada pero concisa en español, explicando los cambios en los siguientes archivos:
                        - Archivos añadidos: ${changes.added.join(', ')}
                        - Archivos modificados: ${changes.modified.join(', ')}
                        - Archivos eliminados: ${changes.deleted.join(', ')}

                        Archivos principales: ${focusFiles.join(', ')}
                        Categoría de cambio: ${changeCategory}

                        La descripción debe:
                        - Ser clara y profesional
                        - Explicar el propósito de los cambios
                        - Mostrar el impacto en el proyecto
                        - Tener un máximo de 3-4 líneas`
                    }]
                }]
            }
        );

        const generatedDescription = response.data.candidates[0].content.parts[0].text.trim();
        return generatedDescription;
    } catch (error) {
        console.error('Detailed description generation error:', error);
        return `Se han realizado ${changeCategory.toLowerCase()} en los archivos ${focusFiles.join(' y ')}. Estos cambios mejoran la funcionalidad y eficiencia del proyecto.`;
    }
}

module.exports = { activate, deactivate };