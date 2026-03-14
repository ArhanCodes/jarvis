import chalk from 'chalk';

export const fmt = {
  banner: (text: string) => chalk.hex('#FFB700').bold(text),
  success: (text: string) => chalk.green(`  ✓ ${text}`),
  error: (text: string) => chalk.red(`  ✗ ${text}`),
  info: (text: string) => chalk.gray(`  ℹ ${text}`),
  warn: (text: string) => chalk.yellow(`  ⚠ ${text}`),
  label: (key: string, value: string) => `  ${chalk.bold(key)}: ${value}`,
  prompt: () => chalk.cyan.bold('jarvis> '),
  heading: (text: string) => chalk.white.bold.underline(`\n  ${text}\n`),
  dim: (text: string) => chalk.dim(text),
  suggestion: (text: string) => chalk.yellow(`    - ${text}`),
  box: (lines: string[]) => {
    const stripped = lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, ''));
    const maxLen = Math.max(...stripped.map(l => l.length));
    const border = chalk.gray('─'.repeat(maxLen + 4));
    const top = chalk.gray('┌') + border + chalk.gray('┐');
    const bot = chalk.gray('└') + border + chalk.gray('┘');
    const body = lines.map((l, i) => {
      const pad = maxLen - stripped[i].length;
      return chalk.gray('│') + '  ' + l + ' '.repeat(pad + 2) + chalk.gray('│');
    });
    return [top, ...body, bot].join('\n');
  },
};
