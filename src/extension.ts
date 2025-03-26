import * as vscode from 'vscode';
import { exec, ExecOptions } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// 创建输出通道
let outputChannel: vscode.OutputChannel;

// 存储上次选择的分支
let lastSelectedBranch: string | undefined;

// 创建一个包装函数来执行命令并确保进程清理
async function executeCommand(command: string, options: ExecOptions, timeout: number = 30000): Promise<{ stdout: string; stderr: string }> {
    return new Promise(async (resolve, reject) => {
        let isCompleted = false;
        
        // 创建超时处理
        const timeoutId = setTimeout(() => {
            if (!isCompleted) {
                isCompleted = true;
                reject(new Error(`命令执行超时: ${command}`));
            }
        }, timeout);

        try {
            const process = exec(command, options, (error, stdout, stderr) => {
                if (isCompleted) return;
                
                clearTimeout(timeoutId);
                isCompleted = true;

                if (error) {
                    reject(error);
                } else {
                    resolve({ stdout, stderr });
                }
            });

            // 确保进程被清理
            process.on('exit', (code) => {
                if (!isCompleted) {
                    clearTimeout(timeoutId);
                    isCompleted = true;
                    if (code === 0) {
                        resolve({ stdout: '', stderr: '' });
                    } else {
                        reject(new Error(`进程退出，退出码: ${code}`));
                    }
                }
            });

            // 处理进程错误
            process.on('error', (err) => {
                if (!isCompleted) {
                    clearTimeout(timeoutId);
                    isCompleted = true;
                    reject(err);
                }
            });
        } catch (err) {
            if (!isCompleted) {
                clearTimeout(timeoutId);
                isCompleted = true;
                reject(err);
            }
        }
    });
}

// 获取所有远程分支
async function getRemoteBranches(workspaceFolder: vscode.WorkspaceFolder): Promise<string[]> {
    const { stdout } = await executeCommand('git branch -r', {
        cwd: workspaceFolder.uri.fsPath
    });
    
    return stdout
        .split('\n')
        .map(branch => branch.trim())
        .filter(branch => branch && !branch.includes('HEAD'))
        .map(branch => branch.replace('origin/', ''));
}

// 获取所有本地分支
async function getLocalBranches(workspaceFolder: vscode.WorkspaceFolder): Promise<string[]> {
    const { stdout } = await executeCommand('git branch', {
        cwd: workspaceFolder.uri.fsPath
    });
    
    return stdout
        .split('\n')
        .map(branch => branch.trim().replace('* ', ''))
        .filter(branch => branch);
}

// 获取所有可用的目标分支
async function getAvailableBranches(workspaceFolder: vscode.WorkspaceFolder): Promise<string[]> {
    const [remoteBranches, localBranches] = await Promise.all([
        getRemoteBranches(workspaceFolder),
        getLocalBranches(workspaceFolder)
    ]);
    
    // 合并远程和本地分支，去重
    const allBranches = [...new Set([...remoteBranches, ...localBranches])];
    return allBranches.sort();
}

// 检查分支是否存在于远程
async function checkRemoteBranchExists(workspaceFolder: vscode.WorkspaceFolder, branch: string): Promise<boolean> {
    try {
        const { stdout } = await executeCommand('git branch -r', {
            cwd: workspaceFolder.uri.fsPath
        });
        return stdout.includes(`origin/${branch}`);
    } catch (error) {
        return false;
    }
}

export function activate(context: vscode.ExtensionContext) {
    // 初始化输出通道
    outputChannel = vscode.window.createOutputChannel('Merge Branch Helper');
    outputChannel.clear();
    
    // 从全局存储中获取上次选择的分支
    lastSelectedBranch = context.globalState.get<string>('lastSelectedBranch') || 'master';
    
    // 创建目标分支显示按钮
    const targetBranchItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        101
    );
    targetBranchItem.command = 'merge-branch-helper.selectTargetBranch';
    targetBranchItem.text = `$(git-branch) ${lastSelectedBranch}`;
    targetBranchItem.tooltip = "点击切换目标分支";
    targetBranchItem.show();

    // 创建合并按钮
    const mergeButton = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    mergeButton.command = 'merge-branch-helper.mergeToBranch';
    mergeButton.text = "$(git-merge) 合并";
    mergeButton.tooltip = `点击合并到 ${lastSelectedBranch}`;
    mergeButton.show();
    
    // 检查是否在 Git 仓库中
    const checkGitRepository = async () => {
        try {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                outputChannel.appendLine('没有打开的工作区，隐藏按钮');
                targetBranchItem.hide();
                mergeButton.hide();
                return;
            }

            await executeCommand('git rev-parse --git-dir', {
                cwd: workspaceFolder.uri.fsPath
            });
            targetBranchItem.show();
            mergeButton.show();
        } catch (error) {
            outputChannel.appendLine('不是 Git 仓库，隐藏按钮');
            targetBranchItem.hide();
            mergeButton.hide();
        }
    };

    // 立即执行初始检查
    checkGitRepository().catch(error => {
        outputChannel.appendLine(`初始化检查失败: ${error.message}`);
    });

    // 注册选择目标分支命令
    let selectTargetDisposable = vscode.commands.registerCommand('merge-branch-helper.selectTargetBranch', async () => {
        try {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                throw new Error('没有打开的工作区');
            }

            // 获取当前分支
            const { stdout: currentBranch } = await executeCommand('git branch --show-current', {
                cwd: workspaceFolder.uri.fsPath
            });
            const currentBranchName = currentBranch.trim();

            // 获取所有可用分支
            const branches = await getAvailableBranches(workspaceFolder);
            
            // 创建快速选择项
            const quickPickItems = branches
                .filter(branch => branch !== currentBranchName)
                .map(branch => ({
                    label: branch,
                    description: branch === lastSelectedBranch ? '(当前目标)' : '',
                    detail: `设为合并目标分支`
                }));

            // 显示分支选择器
            const selected = await vscode.window.showQuickPick(quickPickItems, {
                placeHolder: '选择新的目标分支',
                title: '选择目标分支'
            });

            if (!selected) {
                return;
            }

            // 更新目标分支
            lastSelectedBranch = selected.label;
            await context.globalState.update('lastSelectedBranch', lastSelectedBranch);
            
            // 更新状态栏显示
            targetBranchItem.text = `$(git-branch) ${lastSelectedBranch}`;
            mergeButton.tooltip = `点击合并到 ${lastSelectedBranch}`;
        } catch (error: any) {
            outputChannel.appendLine(`错误: ${error.message}`);
            outputChannel.show(true);
            vscode.window.showErrorMessage(`设置目标分支失败: ${error.message}`);
        }
    });

    // 注册合并命令
    let mergeDisposable = vscode.commands.registerCommand('merge-branch-helper.mergeToBranch', async () => {
        try {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                throw new Error('没有打开的工作区');
            }

            // 获取当前分支
            const { stdout: currentBranch } = await executeCommand('git branch --show-current', {
                cwd: workspaceFolder.uri.fsPath
            });
            const currentBranchName = currentBranch.trim();

            if (currentBranchName === lastSelectedBranch) {
                throw new Error('不能合并到当前分支');
            }

            // 检查目标分支是否存在于远程
            if (!lastSelectedBranch) {
                throw new Error('未选择目标分支');
            }
            const hasRemoteBranch = await checkRemoteBranchExists(workspaceFolder, lastSelectedBranch);

            // 显示确认对话框
            const message = hasRemoteBranch 
                ? `确定要将当前分支 '${currentBranchName}' 合并到 '${lastSelectedBranch}' 并推送到远程吗？`
                : `确定要将当前分支 '${currentBranchName}' 合并到 '${lastSelectedBranch}' 吗？\n注意：目标分支在远程不存在`;
            
            const answer = await vscode.window.showInformationMessage(
                message,
                '确定',
                '取消'
            );

            if (answer !== '确定') {
                return;
            }

            // 检查是否有未提交的更改
            const { stdout: status } = await executeCommand('git status --porcelain', {
                cwd: workspaceFolder.uri.fsPath
            });
            if (status.trim()) {
                throw new Error('有未提交的更改，请先提交或暂存更改');
            }

            // 更新状态栏显示
            mergeButton.text = "$(sync~spin) 正在合并...";
            mergeButton.tooltip = "正在进行合并操作";

            // 切换到目标分支
            await executeCommand(`git checkout ${lastSelectedBranch}`, {
                cwd: workspaceFolder.uri.fsPath
            });

            // 拉取目标分支最新代码
            if (hasRemoteBranch) {
                try {
                    await executeCommand(`git pull origin ${lastSelectedBranch}`, {
                        cwd: workspaceFolder.uri.fsPath
                    });
                } catch (pullError: any) {
                    // 如果拉取失败，切换回原分支并抛出错误
                    await executeCommand(`git checkout ${currentBranchName}`, {
                        cwd: workspaceFolder.uri.fsPath
                    });
                    outputChannel.appendLine(`错误: 拉取最新代码失败: ${pullError.message}`);
                    outputChannel.show(true);
                    throw new Error(`拉取最新代码失败: ${pullError.message}`);
                }
            }

            // 合并当前分支
            try {
                await executeCommand(`git merge ${currentBranchName}`, {
                    cwd: workspaceFolder.uri.fsPath
                });
            } catch (mergeError: any) {
                outputChannel.appendLine(`错误: 合并失败: ${mergeError.message}`);
                outputChannel.show(true);
                throw new Error(`合并失败: ${mergeError.message}`);
            }

            // 推送到远程
            try {
                await executeCommand(`git push origin ${lastSelectedBranch}`, {
                    cwd: workspaceFolder.uri.fsPath
                });
            } catch (pushError: any) {
                // 如果推送失败，提示用户但不中断操作
                outputChannel.appendLine(`警告: 推送到远程失败: ${pushError.message}`);
                outputChannel.show(true);
                vscode.window.showWarningMessage(`合并成功，但推送到远程失败: ${pushError.message}`);
            }

            // 切换回原分支
            await executeCommand(`git checkout ${currentBranchName}`, {
                cwd: workspaceFolder.uri.fsPath
            });

            // 恢复状态栏显示
            mergeButton.text = "$(git-merge) 合并";
            mergeButton.tooltip = `点击合并到 ${lastSelectedBranch}`;

            // 只显示成功提示，不显示输出
            vscode.window.showInformationMessage(`成功将 ${currentBranchName} 合并到 ${lastSelectedBranch}`);
        } catch (error: any) {
            // 恢复状态栏显示
            mergeButton.text = "$(git-merge) 合并";
            mergeButton.tooltip = `点击合并到 ${lastSelectedBranch}`;
            
            outputChannel.appendLine(`错误: ${error.message}`);
            outputChannel.show(true);
            vscode.window.showErrorMessage(`操作失败: ${error.message}`);
        }
    });

    // 监听工作区变化
    const workspaceWatcher = vscode.workspace.onDidChangeWorkspaceFolders(() => {
        checkGitRepository();
    });

    context.subscriptions.push(
        mergeDisposable,
        selectTargetDisposable,
        targetBranchItem,
        mergeButton,
        workspaceWatcher,
        outputChannel
    );
}

export function deactivate() {
    if (outputChannel) {
        outputChannel.dispose();
    }
} 