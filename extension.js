/**
 * VSCode extension for automatic git commits with AI-generated commit messages
 * Flow:
 * 1. Detect git changes in workspace
 * 2. Get detailed diffs of modified files
 * 3. Generate commit message using AI
 * 4. Create git commit with detailed explanation
 */

const vscode = require('vscode');
const child_process = require('child_process');
const axios = require('axios');
const path = require('path');

// Constants for configuration and messages
const CONFIG = {
    API_KEY_SETTING: 'tinieblasautocommit.apiKey',
    COMMAND_NAME: 'tinieblasautocommit.autoCommit',
    API_ENDPOINT: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent'
};

const MESSAGES = {
    NO_WORKSPACE: 'No workspace folder detected.',
    NO_REPOSITORY: 'No git repository detected.',
    NO_CHANGES: 'No changes to commit.',
    NO_API_KEY: 'Please configure your API key in the extension settings.',
    COMMIT_SUCCESS: 'Commit made successfully.'
};

/**
 * Step 1: Extension Activation
 * Sets up the command and initializes the extension
 */
function activate(context) {
    const disposable = vscode.commands.registerCommand(
        CONFIG.COMMAND_NAME, 
        handleAutoCommit
    );
    context.subscriptions.push(disposable);
}

/**
 * Step 2: Main Command Handler
 * Orchestrates the entire commit process
 */
async function handleAutoCommit() {
    try {
        // 2.1: Get workspace path
        const workspacePath = getWorkspacePath();
        if (!workspacePath) return;

        // 2.2: Get git status
        const gitStatus = await runGitCommand('git status --porcelain', workspacePath);
        if (!gitStatus) {
            vscode.window.showErrorMessage(MESSAGES.NO_REPOSITORY);
            return;
        }

        // 2.3: Process changes
        const changes = classifyChanges(gitStatus);
        if (!changes || isEmptyChanges(changes)) {
            vscode.window.showInformationMessage(MESSAGES.NO_CHANGES);
            return;
        }

        // 2.4: Generate commit
        await createCommit(changes, workspacePath);

    } catch (error) {
        handleError(error);
    }
}

/**
 * Step 3: Git Operations
 * Handles all git-related operations
 */
async function createCommit(changes, workspacePath) {
    // 3.1: Get file diffs before staging
    const diffs = await getDiffsForModifiedFiles(changes.modified, workspacePath);
    
    // 3.2: Generate commit message
    const { shortMessage, detailedMessage } = await generateDetailedCommitMessage(changes, diffs);
    
    // 3.3: Create commit
    await runGitCommand(`git add .`, workspacePath);
    await runGitCommand(`git commit -m "${shortMessage}" -m "${detailedMessage}"`, workspacePath);

    vscode.window.showInformationMessage(MESSAGES.COMMIT_SUCCESS);
}

/**
 * Step 4: Diff Generation
 * Gets detailed diffs for modified files
 */
async function getDiffsForModifiedFiles(modifiedFiles, cwd) {
    const diffs = {};
    for (const file of modifiedFiles) {
        try {
            // console.log(`Fetching diff for ${file}`);
            // Obtener el diff del archivo
            const diff = await runGitCommand(`git diff --staged -- "${file}"`, cwd);
            
            // Si no hay cambios en el archivo, obtener el diff sin --staged
            if (!diff) {
                diffs[file] = await runGitCommand(`git diff -- "${file}"`, cwd);
            } else {
                diffs[file] = diff;
            }

            // console.log(`Diff for ${file}:`, diffs[file]); // Depuración
        } catch (error) {
            console.error(`Error fetching diff for ${file}:`, error);
            diffs[file] = 'Error obtaining diff';
        }
    }
    return diffs;
}

/**
 * Step 5: Commit Message Generation
 * Generates AI-powered commit messages
 */
async function generateDetailedCommitMessage(changes, diffs) {
    try {
        // 5.1: Verify API key
        const apiKey = vscode.workspace.getConfiguration().get(CONFIG.API_KEY_SETTING);
        if (!apiKey) {
            vscode.window.showErrorMessage(MESSAGES.NO_API_KEY);
            return getDefaultCommitMessage();
        }

        // 5.2: Prepare commit data
        const { shortMessage, changeAnalysis } = prepareCommitData(changes, diffs);

        // 5.3: Generate AI explanation
        const aiExplanation = await getAIExplanation(changeAnalysis, apiKey);
        console.log('AI explanation:', aiExplanation);

        // 5.4: Format final message
        return formatCommitMessage(shortMessage, aiExplanation);
    } catch (error) {
        console.error('Commit message generation error:', error);
        return getDefaultCommitMessage();
    }
}

/**
 * Step 6: Helper Functions
 * Utility functions for various operations
 */

// 6.1: Workspace helpers
function getWorkspacePath() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage(MESSAGES.NO_WORKSPACE);
        return null;
    }
    return workspaceFolders[0].uri.fsPath;
}

// 6.2: Git helpers
function runGitCommand(command, cwd) {
    return new Promise((resolve, reject) => {
        child_process.exec(command, { cwd }, (error, stdout, stderr) => {
            if (error) reject(`Git error: ${error.message}`);
            else if (stderr) reject(`Git stderr: ${stderr.trim()}`);
            else resolve(stdout.trim());
        });
    });
}

// 6.3: Change classification
function classifyChanges(status) {
    const changes = {
        added: [],
        modified: [],
        deleted: []
    };

    status.split('\n').forEach(line => {
        if (!line) return;
        const changeType = line.slice(0, 2).trim();
        const filePath = line.slice(3);

        if (changeType === 'A') changes.added.push(filePath);
        else if (changeType === 'M') changes.modified.push(filePath);
        else if (changeType === 'D') changes.deleted.push(filePath);
    });

    return changes;
}

// Utility function to get emoji/icon for file status
function getStatusIcon(status) {
    switch (status) {
        case 'add':
            return '✨'; // Added files
        case 'update':
            return '📝'; // Modified files
        case 'remove':
            return '🗑️'; // Deleted files
        default:
            return '•';
    }
}

// Function to format a single file with its status icon
function formatFileWithStatus(file, status) {
    const icon = getStatusIcon(status);
    return `${icon} ${file}`;
}

// Main function to prepare commit data
function prepareCommitData(changes, diffs) {
    // Crear un array de archivos con su estado
    const filesWithStatus = [
        ...changes.added.map(file => ({ file, status: 'add' })),
        ...changes.modified.map(file => ({ file, status: 'update' })),
        ...changes.deleted.map(file => ({ file, status: 'remove' }))
    ];

    // Formatear los nombres de los archivos (solo el nombre base)
    const allChangedFiles = filesWithStatus.map(({ file, status }) => {
        const fileName = path.basename(file); // Extraer solo el nombre del archivo
        return formatFileWithStatus(fileName, status); // Aplicar el icono
    });

    // Obtener el tipo de cambio más frecuente
    const changeTypes = filesWithStatus.map(({ status }) => status);
    const primaryChangeType = getMostFrequentChangeType(changeTypes);

    // Obtener la categoría del cambio
    const focusFiles = getMostSignificantFiles(allChangedFiles);
    const changeCategory = getChangeCategory(focusFiles);

    // Obtener el emoji para el tipo de cambio principal
    const emoji = getEmojiForChangeType(primaryChangeType);

    // Formatear el mensaje corto
    const shortMessage = `${emoji} ${changeCategory}: ${allChangedFiles.join(', ')}`;

    // Preparar el análisis de cambios para la IA
    const changeAnalysis = Object.entries(diffs)
        .map(([file, diff]) => {
            const changes = parseDiff(diff);
            return `File: ${file}\nChanges:\n${changes}`;
        })
        .join('\n\n');

    return { shortMessage, changeAnalysis };
}

// 6.5: File analysis helpers
function getMostSignificantFiles(files) {
    const significantFiles = files.filter(file => 
        !file.includes('node_modules/') && 
        !file.includes('.lock') && 
        !file.includes('.log')
    );
    
    const priorityExtensions = ['.py', '.js', '.ts', '.json', '.yml', '.yaml', '.gitignore'];
    
    return significantFiles
        .sort((a, b) => {
            const aExt = path.extname(a);
            const bExt = path.extname(b);
            const aIsPriority = priorityExtensions.includes(aExt);
            const bIsPriority = priorityExtensions.includes(bExt);
            
            if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;
            return a.length - b.length;
        })
        .slice(0, 3)
        .map(file => path.basename(file));
}

function getChangeCategory(files) {
    const fileTypes = files.map(file => path.extname(file).replace('.', ''));
    
    if (fileTypes.includes('gitignore')) return 'Configuration';
    if (fileTypes.includes('py')) return 'Enhancement';
    if (fileTypes.includes('js') || fileTypes.includes('ts')) return 'Development';
    if (fileTypes.includes('json')) return 'Configuration';
    
    return 'Update';
}

// 6.6: Default values and error handling
function getDefaultCommitMessage() {
    return {
        shortMessage: '🛠️ Project update',
        detailedMessage: 'General project modifications were made.'
    };
}

function handleError(error) {
    console.error('Auto commit error:', error);
    vscode.window.showErrorMessage(`Error: ${error}`);
}

function isEmptyChanges(changes) {
    return !changes.added.length && !changes.modified.length && !changes.deleted.length;
}

// Export module
module.exports = {
    activate,
    deactivate: () => {} // Clean deactivation
};

/**
 * Step 7: AI Integration Functions
 * Handles AI-related operations for commit message generation
 */
async function getAIExplanation(changeAnalysis, apiKey) {
    const promptText = `Analiza estos cambios de código y genera un resumen conciso en un solo párrafo, explicando el propósito de las modificaciones. Limita el resumen a 500 caracteres.

    ${changeAnalysis}

    Por favor:
    1. Explica el propósito de los cambios de manera clara y concisa.
    2. Agrupa cambios relacionados.
    3. No incluyas detalles irrelevantes o triviales.
    4. Limita el resumen a un solo párrafo.
    `;
    
    try {
        const aiResponse = await axios.post(
            CONFIG.API_ENDPOINT + '?key=' + apiKey,
            {
                contents: [{
                    parts: [{
                        text: promptText
                    }]
                }]
            }
        );

        return aiResponse.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 
               'No se pudo generar una explicación detallada.';
    } catch (error) {
        console.error('AI explanation error:', error);
        return 'Error generating AI explanation.';
    }
}

/**
 * Step 8: Commit Message Formatting
 * Functions for formatting and organizing commit messages
 */
function formatCommitMessage(shortMessage, aiExplanation) {
    // Limitar el resumen a 1000 caracteres (ajusta según sea necesario)
    const maxLength = 1000;
    const truncatedExplanation = aiExplanation.slice(0, maxLength);

    return {
        shortMessage: shortMessage.slice(0, 72),
        detailedMessage: truncatedExplanation
    };
}
/**
 * Step 9: Change Analysis Functions
 * Functions for analyzing and categorizing changes
 */
function generateChangeAnalysis(diffs) {
    return Object.entries(diffs)
        .map(([file, diff]) => {
            const changes = parseDiff(diff);
            return `File: ${file}\nChanges:\n${changes}`;
        })
        .join('\n\n');
}

function getMostFrequentChangeType(types) {
    const typeCount = types.reduce((acc, type) => {
        acc[type] = (acc[type] || 0) + 1;
        return acc;
    }, {});
    return Object.keys(typeCount).reduce((a, b) => typeCount[a] > typeCount[b] ? a : b);
}

function getEmojiForChangeType(type) {
    const emojis = {
        add: '✨',
        update: '🔧',
        remove: '🗑️',
        default: '💡'
    };
    return emojis[type] || emojis.default;
}

/**
 * Step 10: Diff Parsing
 * Functions for parsing and formatting git diffs
 */
function parseDiff(diff) {
    if (!diff) return 'No hay cambios disponibles';

    const lines = diff.split('\n');
    let added = 0;
    let removed = 0;
    let changes = [];

    for (const line of lines) {
        // Ignorar líneas de metadata de git
        if (line.startsWith('diff --git') || 
            line.startsWith('index') || 
            line.startsWith('+++') || 
            line.startsWith('---')) {
            continue;
        }

        // Contar líneas añadidas y eliminadas
        if (line.startsWith('+') && !line.startsWith('+++')) {
            added++;
            changes.push(`+ ${line.substring(1).trim()}`);
        } else if (line.startsWith('-') && !line.startsWith('---')) {
            removed++;
            changes.push(`- ${line.substring(1).trim()}`);
        }
    }

    // Crear un resumen conciso
    if (added === 0 && removed === 0) {
        return 'No se detectaron cambios específicos';
    }

    const summary = `+${added} -${removed}`;
    const details = changes.slice(0, 5).join('\n'); // Mostrar solo las primeras 5 líneas de cambios

    return `${summary}\n${details}`;
}


