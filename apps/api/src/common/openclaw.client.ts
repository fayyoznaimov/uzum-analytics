import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';

/**
 * Модель по умолчанию для ходов через OpenClaw. Без явного --model берётся
 * умолчание агента main — Opus, который делит дневной лимит подписки с ботами
 * @parisahome_erp_bot и @parisahome_hr_bot. Для коротких генераций (пара
 * предложений на отзыв) Sonnet справляется не хуже и тратит лимит бережнее.
 */
export const DEFAULT_OPENCLAW_MODEL = 'claude-cli/claude-sonnet-5';

export type OpenclawRunOptions = {
  /** Модель в формате provider/model. Пусто — модель агента по умолчанию. */
  model?: string | null;
  /** Уровень размышления. Для коротких генераций достаточно off. */
  thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'adaptive';
  timeoutSec?: number;
};

export type OpenclawResult = {
  text: string;
  model: string | null;
  provider: string | null;
  usage: Record<string, number> | null;
};

/**
 * Запуск разовой генерации через локальный OpenClaw.
 *
 * Зачем это здесь: на сервере уже стоит OpenClaw с рабочим входом в Claude
 * (тот же, что у ботов @parisahome_erp_bot и @parisahome_hr_bot). Через него
 * можно генерировать ответы на отзывы, не заводя отдельный API-ключ и не храня
 * никаких секретов в базе приложения.
 *
 * Вызывается `openclaw agent exec` — один изолированный ход без сессии и без
 * истории. `--log-level silent` убирает служебные строки, поэтому на stdout
 * остаётся чистый JSON-конверт.
 */
@Injectable()
export class OpenclawClient {
  private readonly logger = new Logger(OpenclawClient.name);
  private readonly bin = process.env.OPENCLAW_BIN || 'openclaw';
  /** Рабочий каталог хода. Намеренно нейтральный: чтобы агенту не подтянулся чужой CLAUDE.md. */
  private readonly cwd = process.env.OPENCLAW_CWD || tmpdir();

  /**
   * PATH для дочернего процесса. Само приложение запущено на Node 20 из nvm, а
   * `openclaw` — это `#!/usr/bin/env node` и требует Node 26 из системы. Если
   * отдать ему свой PATH, он найдёт node 20 и откажется стартовать, поэтому
   * каталоги nvm вырезаются. Полностью переопределяется через OPENCLAW_PATH.
   */
  private readonly path = process.env.OPENCLAW_PATH
    || (process.env.PATH || '').split(delimiter).filter((entry) => entry && !/[\\/]\.nvm[\\/]/.test(entry)).join(delimiter)
    || '/usr/local/bin:/usr/bin:/bin';

  /** Настроен ли OpenClaw в принципе — проверяется запуском `openclaw --version`. */
  async version(timeoutSec = 20) {
    const { stdout } = await this.spawn(['--version'], '', timeoutSec);
    return stdout.trim().split('\n').pop()?.trim() || '';
  }

  async run(prompt: string, options: OpenclawRunOptions = {}): Promise<OpenclawResult> {
    const timeoutSec = Math.max(30, Number(options.timeoutSec || process.env.OPENCLAW_TIMEOUT_SEC || 180));
    const args = [
      '--log-level', 'silent',
      'agent', 'exec',
      // Даёт использовать вход, сделанный через Claude CLI, а не только
      // переменные окружения. Без этого флага запуск падает с 401.
      '--no-auth-env-only',
      '--json',
      '--thinking', options.thinking || 'off',
      '--timeout', String(timeoutSec),
      '--message-file', '-',
    ];
    // Агента выбирать не нужно: `agent exec` — изолированный ход на конфиге по
    // умолчанию, без сессии, истории и чужого workspace.
    if (options.model?.trim()) args.push('--model', options.model.trim());

    const { stdout, stderr, code } = await this.spawn(args, prompt, timeoutSec + 30);
    const envelope = this.parseEnvelope(stdout);
    if (!envelope) {
      const detail = (stderr || stdout).trim().split('\n').slice(-3).join(' ').slice(0, 300);
      throw new Error(`OpenClaw не вернул результат (код ${code})${detail ? `: ${detail}` : ''}`);
    }
    if (envelope.ok !== true) {
      throw new Error(`OpenClaw: ${String(envelope.error?.message || envelope.status || 'неизвестная ошибка').slice(0, 300)}`);
    }
    const text = String(envelope.final ?? envelope.payloads?.[0]?.text ?? '').trim();
    if (!text) throw new Error('OpenClaw вернул пустой ответ');
    return {
      text,
      model: envelope.model ?? null,
      provider: envelope.provider ?? null,
      usage: envelope.usage ?? null,
    };
  }

  private spawn(args: string[], input: string, timeoutSec: number) {
    return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
      // shell не используется: аргументы уходят массивом, поэтому текст отзыва
      // не может превратиться в команду.
      const child = spawn(this.bin, args, {
        cwd: this.cwd,
        windowsHide: true,
        // NODE_OPTIONS вычищается: флаги, выставленные для API, чужому рантайму не нужны.
        env: { ...process.env, PATH: this.path, NODE_OPTIONS: '' },
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`OpenClaw не ответил за ${timeoutSec} с`));
      }, timeoutSec * 1000);

      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (error: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error?.code === 'ENOENT'
          ? new Error(`Не найден исполняемый файл «${this.bin}». Укажите путь в OPENCLAW_BIN.`)
          : error);
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, code });
      });

      child.stdin.on('error', () => { /* закрытый stdin разберёт обработчик close */ });
      child.stdin.end(input, 'utf8');
    });
  }

  /**
   * Достаёт JSON-конверт из вывода. `--log-level silent` обычно оставляет только
   * его, но предупреждения Node пишутся мимо логгера, поэтому ищем последний
   * сбалансированный объект, а не парсим всё подряд.
   */
  private parseEnvelope(stdout: string): any | null {
    let found: any = null;
    for (let start = stdout.indexOf('{'); start !== -1; start = stdout.indexOf('{', start + 1)) {
      const end = this.matchBrace(stdout, start);
      if (end === -1) continue;
      try {
        const value = JSON.parse(stdout.slice(start, end + 1));
        if (value && typeof value === 'object' && 'ok' in value) found = value;
      } catch {
        // не наш кусок — пробуем следующую скобку
      }
    }
    return found;
  }

  /** Индекс закрывающей скобки для объекта, начинающегося в start (строки и экранирование учтены). */
  private matchBrace(text: string, start: number) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const char = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    return -1;
  }
}
