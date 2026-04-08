import { AgentResult } from './executor.js';

// ── Types ──

export enum Priority {
  HIGH = 1,
  NORMAL = 2,
  LOW = 3,
}

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type TaskExecutor = () => Promise<AgentResult>;

export interface TaskInfo {
  id: string;
  goal: string;
  priority: Priority;
  status: TaskStatus;
  submittedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  result?: AgentResult;
  error?: string;
}

interface QueuedTask {
  info: TaskInfo;
  executor: TaskExecutor;
  resolve: (result: AgentResult) => void;
  reject: (error: Error) => void;
}

// ── Task Queue ──

export class TaskQueue {
  private queue: QueuedTask[] = [];
  private running: QueuedTask | null = null;
  private taskCounter = 0;

  submit(goal: string, priority: Priority, executor: TaskExecutor): { taskId: string; promise: Promise<AgentResult> } {
    this.taskCounter++;
    const id = `task-${this.taskCounter}-${Date.now().toString(36)}`;

    let resolve!: (result: AgentResult) => void;
    let reject!: (error: Error) => void;

    const promise = new Promise<AgentResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const task: QueuedTask = {
      info: {
        id,
        goal,
        priority,
        status: 'queued',
        submittedAt: new Date(),
      },
      executor,
      resolve,
      reject,
    };

    // Insert sorted by priority (lower number = higher priority)
    const insertIdx = this.queue.findIndex(t => t.info.priority > priority);
    if (insertIdx === -1) {
      this.queue.push(task);
    } else {
      this.queue.splice(insertIdx, 0, task);
    }

    // Kick off processing if idle
    this.processNext();

    return { taskId: id, promise };
  }

  cancel(taskId: string): boolean {
    // Check queued tasks
    const idx = this.queue.findIndex(t => t.info.id === taskId);
    if (idx !== -1) {
      const task = this.queue.splice(idx, 1)[0];
      task.info.status = 'cancelled';
      task.info.completedAt = new Date();
      task.reject(new Error('Task cancelled'));
      return true;
    }

    // Cannot cancel a running task (it's mid-execution)
    if (this.running?.info.id === taskId) {
      // Mark for cancellation — the executor will see the status change
      this.running.info.status = 'cancelled';
      return true;
    }

    return false;
  }

  getStatus(taskId: string): TaskInfo | undefined {
    if (this.running?.info.id === taskId) {
      return { ...this.running.info };
    }
    const queued = this.queue.find(t => t.info.id === taskId);
    if (queued) return { ...queued.info };
    return undefined;
  }

  getAllStatuses(): TaskInfo[] {
    const all: TaskInfo[] = [];
    if (this.running) {
      all.push({ ...this.running.info });
    }
    for (const t of this.queue) {
      all.push({ ...t.info });
    }
    return all;
  }

  private async processNext(): Promise<void> {
    if (this.running || this.queue.length === 0) return;

    const task = this.queue.shift()!;
    this.running = task;
    task.info.status = 'running';
    task.info.startedAt = new Date();

    try {
      const result = await task.executor();

      // Check if cancelled during execution
      if ((task.info.status as TaskStatus) === 'cancelled') {
        task.reject(new Error('Task cancelled during execution'));
      } else {
        task.info.status = 'completed';
        task.info.completedAt = new Date();
        task.info.result = result;
        task.resolve(result);
      }
    } catch (err) {
      if ((task.info.status as TaskStatus) !== 'cancelled') {
        task.info.status = 'failed';
        task.info.completedAt = new Date();
        task.info.error = err instanceof Error ? err.message : String(err);
      }
      task.reject(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.running = null;
      this.processNext();
    }
  }
}

// ── Singleton ──

let instance: TaskQueue | null = null;

export function getTaskQueue(): TaskQueue {
  if (!instance) {
    instance = new TaskQueue();
  }
  return instance;
}
