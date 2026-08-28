import * as readline from 'readline';
import chalk from 'chalk';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

export function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(chalk.cyan(`\n${question}\n> `), (answer) => {
      resolve(answer.trim());
    });
  });
}

export async function askMultiline(prompt: string): Promise<string> {
  console.log(chalk.cyan(`\n${prompt}`));
  console.log(chalk.gray('(Type your response. Enter a blank line when done.)\n> '));

  const lines: string[] = [];
  return new Promise((resolve) => {
    const lineHandler = (line: string) => {
      if (line === '') {
        rl.removeListener('line', lineHandler);
        resolve(lines.join('\n'));
      } else {
        lines.push(line);
        process.stdout.write('> ');
      }
    };
    rl.on('line', lineHandler);
  });
}

export async function awaitApproval(prompt: string): Promise<boolean> {
  while (true) {
    const answer = await ask(`${prompt}\n[y]es to approve / [n]o to revise / [q]uit`);
    const lower = answer.toLowerCase();
    if (lower === 'y' || lower === 'yes') return true;
    if (lower === 'n' || lower === 'no') return false;
    if (lower === 'q' || lower === 'quit') {
      console.log(chalk.yellow('\nSession ended by user.'));
      closeInput();
      process.exit(0);
    }
    console.log(chalk.red('Please enter y, n, or q.'));
  }
}

export function header(text: string): void {
  const border = '─'.repeat(text.length + 4);
  console.log(chalk.blue(`\n┌${border}┐`));
  console.log(chalk.blue(`│  ${chalk.bold(text)}  │`));
  console.log(chalk.blue(`└${border}┘\n`));
}

export function section(label: string): void {
  console.log(chalk.yellow(`\n▶ ${label}`));
}

export function success(msg: string): void {
  console.log(chalk.green(`✓ ${msg}`));
}

export function warn(msg: string): void {
  console.log(chalk.yellow(`⚠ ${msg}`));
}

export function error(msg: string): void {
  console.log(chalk.red(`✗ ${msg}`));
}

export function info(msg: string): void {
  console.log(chalk.gray(`  ${msg}`));
}

export function closeInput(): void {
  rl.close();
}
