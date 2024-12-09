const vscode = require('vscode');
const child_process = require('child_process');
const axios = require('axios');

function activate(context) {
    console.log('Activating Auto Commit Extension...');

    let disposable = vscode.commands.registerCommand('tinieblasautocommit.autoCommit', async () => {
        // Obtener la ruta del proyecto
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            vscode.window.showErrorMessage('No workspace folder detected.');
            return;
        }
        const workspacePath = workspaceFolders[0].uri.fsPath;
        console.log(`Workspace Path: ${workspacePath}`);
        vscode.window.showInformationMessage(`Workspace Path: ${workspacePath}`);

        try {
            // Detectar si estamos en un repositorio git
            const gitStatus = await runGitCommand('git status --porcelain', workspacePath);
            if (!gitStatus) {
                vscode.window.showErrorMessage('No git repository detected.');
                return;
            }

            // Clasificar los cambios (A = Added, M = Modified, D = Deleted)
            const changes = classifyChanges(gitStatus);

            // Si no hay cambios
            if (!changes) {
                vscode.window.showInformationMessage('No changes to commit.');
                return;
            }

            // Generar mensaje de commit usando Gemini
            const commitMessage = await generateCommitMessage(changes);

            // Hacer commit
            await runGitCommand(`git add .`, workspacePath);
            await runGitCommand(`git commit -m "${commitMessage}"`, workspacePath);

            vscode.window.showInformationMessage('Commit made successfully.');
        } catch (err) {
            vscode.window.showErrorMessage(`Error: ${err}`);
        }
    });

    context.subscriptions.push(disposable);
}

function deactivate() {}

async function runGitCommand(command, cwd) {
    console.log(`Running command: ${command} in directory: ${cwd}`);
    return new Promise((resolve, reject) => {
        child_process.exec(command, { cwd }, (error, stdout, stderr) => {
            if (error) {
                console.error(`Git command error: ${error.message}`);
                reject(`Git error: ${error.message}`);
                return;
            }
            if (stderr) {
                console.error(`Git command stderr: ${stderr}`);
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
        const changeType = line.charAt(0);
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

async function generateCommitMessage(changes) {
    try {
        const apiKey = vscode.workspace.getConfiguration().get('mi-extension.apiKey');
        if (!apiKey) {
            vscode.window.showErrorMessage('Por favor, configura tu clave API en la configuración de la extensión.');
            return '';
        }

        const response = await axios.post(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=' + apiKey,
            {
                contents: [{
                    parts: [{
                        text: `Generate a commit message for the following changes: Added files: ${changes.added.join(", ")}, Modified files: ${changes.modified.join(", ")}, Deleted files: ${changes.deleted.join(", ")}`
                    }]
                }]
            }
        );
        const commitMessage = response.data.candidates[0].content.parts[0].text;
        return commitMessage;
    } catch (error) {
        vscode.window.showErrorMessage('Error generating commit message.');
        return 'Commit message generation failed';
    }
}

module.exports = { activate, deactivate };
