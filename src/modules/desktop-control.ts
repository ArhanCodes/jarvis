import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { execSync } from 'child_process';
import { readdirSync, statSync, mkdirSync, renameSync, existsSync } from 'fs';
import { join, extname, basename } from 'path';
import { homedir, tmpdir } from 'os';

const DESKTOP = join(homedir(), 'Desktop');

const EXT_CATEGORIES: Record<string, string[]> = {
  Images: ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp', '.tiff', '.ico', '.heic'],
  Documents: ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.rtf', '.csv', '.pages', '.numbers', '.key'],
  Code: ['.ts', '.js', '.py', '.java', '.c', '.cpp', '.h', '.rs', '.go', '.rb', '.swift', '.sh', '.json', '.yaml', '.yml', '.html', '.css', '.xml', '.sql', '.md'],
  Videos: ['.mp4', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm'],
  Audio: ['.mp3', '.wav', '.aac', '.flac', '.ogg', '.m4a', '.wma'],
  Archives: ['.zip', '.tar', '.gz', '.rar', '.7z', '.bz2', '.xz', '.dmg', '.iso'],
};

function categorize(filename: string): string {
  const ext = extname(filename).toLowerCase();
  for (const [category, exts] of Object.entries(EXT_CATEGORIES)) {
    if (exts.includes(ext)) return category;
  }
  return 'Other';
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export class DesktopControlModule implements JarvisModule {
  name = 'desktop-control' as const;
  description = 'Control desktop wallpaper, organize and clean up Desktop files';

  patterns: PatternDefinition[] = [
    {
      intent: 'set-wallpaper',
      patterns: [
        /^set\s+(?:desktop\s+)?wallpaper\s+(?:to\s+)?(.+)/i,
        /^change\s+(?:desktop\s+)?wallpaper\s+(?:to\s+)?(.+)/i,
        /^wallpaper\s+(.+)/i,
      ],
      extract: (match) => ({ source: match[1].trim() }),
    },
    {
      intent: 'organize',
      patterns: [
        /^organize\s+(?:my\s+)?desktop/i,
        /^sort\s+(?:my\s+)?desktop/i,
        /^tidy\s+(?:my\s+)?desktop/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'cleanup',
      patterns: [
        /^clean\s*(?:up)?\s+(?:my\s+)?desktop/i,
        /^desktop\s+clean\s*(?:up)?/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'stats',
      patterns: [
        /^desktop\s+stats/i,
        /^show\s+desktop\s+stats/i,
        /^desktop\s+(?:info|summary|breakdown)/i,
      ],
      extract: () => ({}),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'set-wallpaper': return this.setWallpaper(command.args.source);
      case 'organize': return this.organizeDesktop();
      case 'cleanup': return this.cleanupDesktop();
      case 'stats': return this.desktopStats();
      default: return { success: false, message: `Unknown action: ${command.action}` };
    }
  }

  private async setWallpaper(source: string): Promise<CommandResult> {
    try {
      let imagePath = source;

      // If it's a URL, download it first
      if (/^https?:\/\//i.test(source)) {
        const ext = extname(new URL(source).pathname) || '.jpg';
        imagePath = join(tmpdir(), `jarvis-wallpaper${ext}`);
        try {
          const response = await fetch(source);
          if (!response.ok) {
            return { success: false, message: `Failed to download image: HTTP ${response.status}` };
          }
          const buffer = Buffer.from(await response.arrayBuffer());
          const { writeFileSync } = await import('fs');
          writeFileSync(imagePath, buffer);
        } catch (err) {
          return { success: false, message: `Failed to download image: ${(err as Error).message}` };
        }
      }

      // Resolve ~ in paths
      if (imagePath.startsWith('~')) {
        imagePath = imagePath.replace('~', homedir());
      }

      if (!existsSync(imagePath)) {
        return { success: false, message: `Image file not found: ${imagePath}` };
      }

      const script = `tell application "Finder" to set desktop picture to POSIX file "${imagePath}"`;
      execSync(`osascript -e '${script}'`);

      return {
        success: true,
        message: `Wallpaper set to ${basename(imagePath)}`,
        voiceMessage: 'Wallpaper updated.',
      };
    } catch (err) {
      return { success: false, message: `Failed to set wallpaper: ${(err as Error).message}` };
    }
  }

  private async organizeDesktop(): Promise<CommandResult> {
    try {
      const files = readdirSync(DESKTOP);
      const moved: Record<string, number> = {};
      let skipped = 0;

      for (const file of files) {
        const fullPath = join(DESKTOP, file);
        try {
          const stat = statSync(fullPath);
          if (!stat.isFile() || file.startsWith('.')) {
            skipped++;
            continue;
          }
        } catch {
          skipped++;
          continue;
        }

        const category = categorize(file);
        const destDir = join(DESKTOP, category);

        if (!existsSync(destDir)) {
          mkdirSync(destDir, { recursive: true });
        }

        let destPath = join(destDir, file);
        // Handle name conflicts
        if (existsSync(destPath)) {
          const ext = extname(file);
          const base = basename(file, ext);
          destPath = join(destDir, `${base}_${Date.now()}${ext}`);
        }

        renameSync(fullPath, destPath);
        moved[category] = (moved[category] || 0) + 1;
      }

      if (Object.keys(moved).length === 0) {
        return { success: true, message: 'Desktop is already clean — no files to organize.' };
      }

      const summary = Object.entries(moved)
        .map(([cat, count]) => `    ${cat}: ${count} file${count > 1 ? 's' : ''}`)
        .join('\n');

      return {
        success: true,
        message: `Desktop organized:\n${summary}`,
        voiceMessage: `Organized ${Object.values(moved).reduce((a, b) => a + b, 0)} files into ${Object.keys(moved).length} folders.`,
        data: moved,
      };
    } catch (err) {
      return { success: false, message: `Failed to organize desktop: ${(err as Error).message}` };
    }
  }

  private async cleanupDesktop(): Promise<CommandResult> {
    try {
      const archiveDir = join(DESKTOP, 'Archive');
      if (!existsSync(archiveDir)) {
        mkdirSync(archiveDir, { recursive: true });
      }

      const files = readdirSync(DESKTOP);
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      let movedCount = 0;

      for (const file of files) {
        const fullPath = join(DESKTOP, file);
        try {
          const stat = statSync(fullPath);
          if (!stat.isFile() || file.startsWith('.')) continue;

          if (stat.mtimeMs < thirtyDaysAgo) {
            let destPath = join(archiveDir, file);
            if (existsSync(destPath)) {
              const ext = extname(file);
              const base = basename(file, ext);
              destPath = join(archiveDir, `${base}_${Date.now()}${ext}`);
            }
            renameSync(fullPath, destPath);
            movedCount++;
          }
        } catch {
          continue;
        }
      }

      if (movedCount === 0) {
        return { success: true, message: 'No old files found on Desktop (all less than 30 days old).' };
      }

      return {
        success: true,
        message: `Moved ${movedCount} file${movedCount > 1 ? 's' : ''} older than 30 days to ~/Desktop/Archive/`,
        voiceMessage: `Archived ${movedCount} old files from your desktop.`,
      };
    } catch (err) {
      return { success: false, message: `Failed to clean desktop: ${(err as Error).message}` };
    }
  }

  private async desktopStats(): Promise<CommandResult> {
    try {
      const files = readdirSync(DESKTOP);
      let totalSize = 0;
      let fileCount = 0;
      let dirCount = 0;
      const byType: Record<string, { count: number; size: number }> = {};

      for (const file of files) {
        if (file.startsWith('.')) continue;
        const fullPath = join(DESKTOP, file);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            dirCount++;
            continue;
          }
          fileCount++;
          totalSize += stat.size;

          const category = categorize(file);
          if (!byType[category]) byType[category] = { count: 0, size: 0 };
          byType[category].count++;
          byType[category].size += stat.size;
        } catch {
          continue;
        }
      }

      const breakdown = Object.entries(byType)
        .sort((a, b) => b[1].count - a[1].count)
        .map(([cat, info]) => `    ${cat}: ${info.count} file${info.count > 1 ? 's' : ''} (${formatBytes(info.size)})`)
        .join('\n');

      const message = [
        `Desktop Stats:`,
        `    Files: ${fileCount}`,
        `    Folders: ${dirCount}`,
        `    Total size: ${formatBytes(totalSize)}`,
        ``,
        `  Breakdown:`,
        breakdown || '    (empty)',
      ].join('\n');

      return {
        success: true,
        message,
        voiceMessage: `Your desktop has ${fileCount} files and ${dirCount} folders, totaling ${formatBytes(totalSize)}.`,
        data: { fileCount, dirCount, totalSize, byType },
      };
    } catch (err) {
      return { success: false, message: `Failed to get desktop stats: ${(err as Error).message}` };
    }
  }

  getHelp(): string {
    return [
      '  Desktop Control — manage your desktop',
      '    set wallpaper <url|path>  Set desktop wallpaper from URL or file',
      '    organize desktop          Sort Desktop files into category folders',
      '    cleanup desktop           Archive files older than 30 days',
      '    desktop stats             Show file count, size, and type breakdown',
    ].join('\n');
  }
}
