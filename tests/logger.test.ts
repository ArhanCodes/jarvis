import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger, setLogLevel, getLogLevel } from '../src/utils/logger.js';

describe('createLogger', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    setLogLevel('warn'); // reset
  });

  it('creates a logger with all four methods', () => {
    const log = createLogger('test');
    expect(typeof log.debug).toBe('function');
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
  });

  it('logs error level by default (level=warn)', () => {
    const log = createLogger('mymod');
    log.error('something failed');
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const msg = stderrSpy.mock.calls[0][0] as string;
    expect(msg).toContain('[ERROR]');
    expect(msg).toContain('[mymod]');
    expect(msg).toContain('something failed');
  });

  it('logs warn level at default threshold', () => {
    const log = createLogger('mymod');
    log.warn('watch out');
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect((stderrSpy.mock.calls[0][0] as string)).toContain('[WARN]');
  });

  it('suppresses debug and info at default warn level', () => {
    const log = createLogger('mymod');
    log.debug('hidden');
    log.info('hidden too');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('shows all levels when set to debug', () => {
    setLogLevel('debug');
    const log = createLogger('mymod');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(stderrSpy).toHaveBeenCalledTimes(4);
  });

  it('includes error message when Error object passed', () => {
    const log = createLogger('test');
    log.error('failed', new Error('bad stuff'));
    const msg = stderrSpy.mock.calls[0][0] as string;
    expect(msg).toContain('bad stuff');
  });

  it('includes stringified value for non-Error objects', () => {
    const log = createLogger('test');
    log.warn('issue', 'some string detail');
    const msg = stderrSpy.mock.calls[0][0] as string;
    expect(msg).toContain('some string detail');
  });
});

describe('setLogLevel / getLogLevel', () => {
  afterEach(() => {
    setLogLevel('warn');
  });

  it('gets and sets log level', () => {
    expect(getLogLevel()).toBe('warn');
    setLogLevel('debug');
    expect(getLogLevel()).toBe('debug');
  });
});
