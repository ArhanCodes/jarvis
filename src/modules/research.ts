import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { fmt } from '../utils/formatter.js';
import { speak, isVoiceEnabled } from '../utils/voice-output.js';

// ── Research Module ──
// Integration with Jericho — autonomous research agent.
// Fetches academic papers from arXiv + Semantic Scholar, analyzes trends,
// and generates reports. No API keys required.

const JERICHO_DIR = join(process.env.HOME || '/Users', 'Downloads', 'jericho');

export class ResearchModule implements JarvisModule {
  name = 'research' as const;
  description = 'Research academic papers using Jericho';

  patterns: PatternDefinition[] = [
    {
      intent: 'research',
      patterns: [
        /^(?:research|investigate|study)\s+(.+)/i,
        /^(?:find|search(?:\s+for)?|look\s+up)\s+(?:papers?|research|articles?|studies)\s+(?:on|about|for|regarding)\s+(.+)/i,
        /^(?:academic|paper|literature)\s+search\s+(.+)/i,
        /^jericho\s+(.+)/i,
      ],
      extract: (match, raw) => {
        const topic = (match[1] || '').trim();
        // Extract year range if present: "2020-2025" or "--years 2020-2025"
        const yearMatch = topic.match(/(\d{4})\s*[-–]\s*(\d{4})/);
        const years = yearMatch ? `${yearMatch[1]}-${yearMatch[2]}` : '';
        const cleanTopic = topic.replace(/(\d{4})\s*[-–]\s*(\d{4})/, '').replace(/\s+/g, ' ').trim();
        // Extract max papers if present: "--max 60" or "max 60"
        const maxMatch = topic.match(/(?:--?max\s+|max\s+)(\d+)/i);
        const max = maxMatch ? maxMatch[1] : '';
        const finalTopic = cleanTopic.replace(/(?:--?max\s+|max\s+)\d+/i, '').trim();
        return { topic: finalTopic, years, max, format: 'md' };
      },
    },
    {
      intent: 'research-status',
      patterns: [
        /^(?:research|jericho)\s+status$/i,
      ],
      extract: () => ({}),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    if (command.action === 'research-status') {
      return this.checkStatus();
    }
    return this.runResearch(command.args);
  }

  private checkStatus(): CommandResult {
    const hasJericho = existsSync(join(JERICHO_DIR, 'src', 'index.ts'));
    const hasNodeModules = existsSync(join(JERICHO_DIR, 'node_modules'));

    if (!hasJericho) {
      return { success: false, message: 'Jericho not found at ~/Downloads/jericho' };
    }
    if (!hasNodeModules) {
      return { success: false, message: 'Jericho dependencies not installed. Run: cd ~/Downloads/jericho && npm install' };
    }
    return { success: true, message: 'Jericho is ready. Sources: arXiv, Semantic Scholar' };
  }

  private async runResearch(args: Record<string, string>): Promise<CommandResult> {
    const { topic, years, max, format } = args;

    if (!topic) {
      return { success: false, message: 'What should I research? Usage: research <topic>' };
    }

    // Verify Jericho exists
    if (!existsSync(join(JERICHO_DIR, 'src', 'index.ts'))) {
      return { success: false, message: 'Jericho not found at ~/Downloads/jericho. Clone it first.' };
    }

    if (isVoiceEnabled()) {
      await speak(`Researching ${topic}. This may take a moment.`);
    }
    console.log(fmt.info(`Launching Jericho research agent for: "${topic}"`));
    console.log(fmt.dim('  Fetching from arXiv + Semantic Scholar...'));

    // Build args for Jericho
    const jerichoArgs = ['--import=tsx', join(JERICHO_DIR, 'src', 'index.ts'), topic];

    if (years) {
      jerichoArgs.push('--years', years);
    }
    if (max) {
      jerichoArgs.push('--max', max);
    }

    // Always output markdown for inline display, save docx as well
    const outputName = `research-${topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}.md`;
    const outputPath = join(JERICHO_DIR, outputName);
    jerichoArgs.push('--md', '--output', outputPath);

    return new Promise((resolve) => {
      const child = execFile('node', jerichoArgs, {
        cwd: JERICHO_DIR,
        timeout: 120000, // 2 minute timeout
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
      }, async (error, stdout, stderr) => {
        if (error) {
          const msg = error.killed
            ? 'Research timed out after 2 minutes.'
            : `Research failed: ${stderr || error.message}`;
          resolve({ success: false, message: msg });
          return;
        }

        // Parse the summary line from Jericho's stdout
        const papersMatch = stdout.match(/Papers analyzed:\s*(\d+)/);
        const findingsMatch = stdout.match(/Key findings:\s*(\d+)/);
        const trendsMatch = stdout.match(/Trends tracked:\s*(.+)/);
        const timeMatch = stdout.match(/Time elapsed:\s*([\d.]+)s/);

        const papers = papersMatch ? papersMatch[1] : '?';
        const findings = findingsMatch ? findingsMatch[1] : '?';
        const trends = trendsMatch ? trendsMatch[1].trim() : '?';
        const elapsed = timeMatch ? timeMatch[1] : '?';

        // Read and display a summary from the markdown output
        let summary = '';
        try {
          const { readFileSync } = await import('fs');
          const md = readFileSync(outputPath, 'utf-8');

          // Extract executive summary section
          const summaryMatch = md.match(/## Executive Summary\n+([\s\S]*?)(?=\n##|\n---)/);
          if (summaryMatch) {
            summary = summaryMatch[1].trim();
            // Truncate if too long
            if (summary.length > 500) {
              summary = summary.slice(0, 497) + '...';
            }
          }

          // Extract key findings
          const findingsSection = md.match(/## Key Findings\n+([\s\S]*?)(?=\n##|\n---)/);
          if (findingsSection) {
            const findingsList = findingsSection[1].trim().split('\n').filter(l => l.startsWith('-') || l.startsWith('*'));
            if (findingsList.length > 0) {
              summary += '\n\n  Key Findings:';
              for (const f of findingsList.slice(0, 4)) {
                summary += `\n  ${f}`;
              }
            }
          }

          // Extract rising trends
          const risingSection = md.match(/Rising Trends[\s\S]*?\n((?:\s*\|.+\n)+)/);
          if (risingSection) {
            const lines = risingSection[1].trim().split('\n').filter(l => l.includes('|') && !l.includes('---'));
            if (lines.length > 0) {
              summary += '\n\n  Rising Trends:';
              for (const l of lines.slice(0, 3)) {
                const cells = l.split('|').map(c => c.trim()).filter(Boolean);
                if (cells.length >= 2) {
                  summary += `\n    ${cells[0]} (${cells[1]})`;
                }
              }
            }
          }
        } catch {
          // Couldn't read report, that's fine
        }

        const resultMsg = [
          `Research complete: "${topic}"`,
          `  ${papers} papers analyzed in ${elapsed}s`,
          `  ${findings} key findings | ${trends}`,
          `  Report saved: ${outputPath}`,
        ];

        if (summary) {
          resultMsg.push('', summary);
        }

        if (isVoiceEnabled()) {
          const briefSummary = summary ? summary.split('\n')[0].slice(0, 200) : `Found ${papers} papers on ${topic}`;
          await speak(briefSummary);
        }

        resolve({ success: true, message: resultMsg.join('\n') });
      });

      // Stream Jericho's progress to console
      child.stdout?.on('data', (data: Buffer) => {
        const line = data.toString().trim();
        if (line && !line.startsWith('═') && !line.includes('██')) {
          console.log(fmt.dim(`  [jericho] ${line}`));
        }
      });
    });
  }

  getHelp(): string {
    return [
      '  Research (Jericho)',
      '    research <topic>            Search academic papers',
      '    research <topic> 2020-2025  Filter by year range',
      '    find papers on <topic>      Alternative syntax',
      '    jericho <topic>             Direct Jericho call',
      '    research status             Check Jericho availability',
    ].join('\n');
  }
}
