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
            // console.log("gitStatus: " + gitStatus);

            if (!gitStatus) {
                vscode.window.showErrorMessage('No git repository detected.');
                return;
            }

            const changes = classifyChanges(gitStatus);
            if (!changes) {
                vscode.window.showInformationMessage('No changes to commit.');
                return;
            }

            // Get diffs BEFORE adding files to staging
            const diffs = await getDiffsForModifiedFiles(changes.modified, workspacePath);
            const { shortMessage, detailedMessage } = await generateDetailedCommitMessage(changes, diffs);

            // Now add files and commit
            await runGitCommand(`git add .`, workspacePath);
            await runGitCommand(`git commit -m "${shortMessage}" -m "${detailedMessage}"`, workspacePath);

            vscode.window.showInformationMessage('Commit made successfully.');
        } catch (err) {
            vscode.window.showErrorMessage(`Error: ${err}`);
        }
    });

    context.subscriptions.push(disposable);
}

async function getDiffsForModifiedFiles(modifiedFiles, cwd) {
    const diffs = {};
    for (const file of modifiedFiles) {
        try {
            const diffOutput = await runGitCommand(`git diff -- "${file}"`, cwd);
            console.log(`Diff for ${file}:\n${diffOutput}`);
            diffs[file] = diffOutput;
        } catch (error) {
            console.error(`Error fetching diff for ${file}: ${error}`);
            diffs[file] = 'Error obtaining diff';
        }
    }
    return diffs;
}

async function generateDetailedCommitMessage(changes, diffs) {
    try {
        const apiKey = vscode.workspace.getConfiguration().get('tinieblasautocommit.apiKey');
        if (!apiKey) {
            vscode.window.showErrorMessage('Please configure your API key in the extension settings.');
            return { shortMessage: 'Project update', detailedMessage: 'General project changes.' };
        }

        const allChangedFiles = [...changes.added, ...changes.modified, ...changes.deleted];
        const changeTypes = [
            ...changes.added.map(() => 'add'),
            ...changes.modified.map(() => 'update'),
            ...changes.deleted.map(() => 'remove')
        ];
        
        const primaryChangeType = getMostFrequentChangeType(changeTypes);
        const focusFiles = getMostSignificantFiles(allChangedFiles);
        const changeCategory = getChangeCategory(focusFiles);
        const emoji = getEmojiForChangeType(primaryChangeType);
        
        const shortMessage = `${emoji} ${changeCategory}: ${focusFiles.join(', ')}`;

        // Create a detailed analysis of changes for the API
        const changeAnalysis = Object.entries(diffs).map(([file, diff]) => {
            const changes = parseDiff(diff);
            return `File: ${file}\nChanges:\n${changes}`;
        }).join('\n\n');

        const promptText = `Analiza estos cambios de código y genera un resumen conciso explicando el propósito de cada modificación:

            ${changeAnalysis}

            Por favor:
            1. Explica el propósito de cada cambio
            2. Sé específico pero conciso
            3. Usa lenguaje técnico apropiado
            4. Agrupa cambios relacionados`;

        // console.log("Prompt enviado a la API:", promptText);

        // Generate AI explanation for changes
        const aiResponse = await axios.post(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=' + apiKey,
            {
                contents: [{
                    parts: [{
                        text: promptText
                    }]
                }]
            }
        );

        const aiExplanation = aiResponse.data.candidates[0].content.parts[0].text.trim();
        const detailedMessage = `${aiExplanation}\n\nDetalles técnicos:\n${changes.modified.map(file => 
            `### ${file}\n\`\`\`diff\n${diffs[file]}\n\`\`\``
        ).join('\n')}`;

        return {
            shortMessage: shortMessage.slice(0, 72),
            detailedMessage
        };
    } catch (error) {
        console.error('Commit message generation error:', error);
        return {
            shortMessage: '🛠️ Project update',
            detailedMessage: 'General project modifications were made.'
        };
    }
}

function parseDiff(diff) {
    const lines = diff.split('\n');
    let changes = [];
    let currentHunk = [];

    for (const line of lines) {
        if (line.startsWith('+') && !line.startsWith('++')) {
            changes.push(`Añadido: ${line.substring(1).trim()}`);
        } else if (line.startsWith('-') && !line.startsWith('--')) {
            changes.push(`Eliminado: ${line.substring(1).trim()}`);
        }
    }

    return changes.join('\n');
}

function deactivate() {}

function runGitCommand(command, cwd) {
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
        const changeType = line.slice(0, 2).trim();
        const filePath = line.slice(3);

        if (changeType === 'A') {
            changes.added.push(filePath);
        } else if (changeType === 'M') {
            changes.modified.push(filePath);
        } else if (changeType === 'D') {
            changes.deleted.push(filePath);
        }
    });

    return changes;
}

function getMostSignificantFiles(files) {
    const significantFiles = files.filter(file => 
        !file.includes('node_modules/') && 
        !file.includes('.lock') && 
        !file.includes('.log')
    );
    
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

    return prioritizedFiles.slice(0, 3).map(file => path.basename(file));
}

function getChangeCategory(files) {
    const fileTypes = files.map(file => path.extname(file).replace('.', ''));
    
    if (fileTypes.includes('gitignore')) return 'Configuration';
    if (fileTypes.includes('py')) return 'Enhancement';
    if (fileTypes.includes('js') || fileTypes.includes('ts')) return 'Development';
    if (fileTypes.includes('json')) return 'Configuration';
    
    return 'Update';
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

module.exports = { activate, deactivate };