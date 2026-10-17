// dsh-thinking-guard —— 纯思考空转熔断器
//
// 机理（已实证）：
//   dsh-agent-loop/lib/index.js 的 step() 只在流结束后才做终止判定
//   （1115-1119 行：max-tokens / 零工具调用 / concludesTurn）。
//   dsh-llm-deepseek 的 idleWatchdog 只测「连接是否还有数据到达」
//   （1627 行 idleWatchdog + 1659 行 onActivity 经 parseSse 喂食），
//   模型持续吐 reasoning-delta 时它每 chunk 重置，5 分钟阈值永不触发。
//   结果是「只思考、零 text、零 tool-call」的退化回合没有任何熔断点，
//   只能由用户手动中止。
//
// 本插件挂 agent/assistant-stream 事件，做的是进展型检测（而非活性检测），
// 三重熔断：
//   1. 纯思考时长  thinkingOnlyMs  — 持续仅 reasoning 且零 text/tool-call
//   2. 思考容量    maxThinkingChars — 单次尝试 reasoning 字符总量
//   3. 退化循环    detectDegenerate — 尾部文本出现高密度重复短语
// 命中即调用 agent.cancel({ kind:'hook', reason:'thinking-guard:<档位>' }) 中止当前活动
// （cause 必须落在 harness 的封闭联合 user|parent|disposed|hook 内，其它值会走
// assertNever 抛错并写出 reason:null 的 turn/end，把会话打成白屏），
// 随后尽力向会话注入熔断说明与自动继续指令。

import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const name = 'dsh-thinking-guard';

// 只需事件总线，不注入其它服务。
export const inject = [];

const DEFAULTS = {
    enabled: true,
    // 只思考、无任何 text/tool-call 产出的持续时长上限（毫秒）
    // 45 秒对 flash 类模型偏短：深度推理常有无产出的静默期，容易误伤。
    thinkingOnlyMs: 90000,
    // 单次尝试 reasoning 字符总量上限
    maxThinkingChars: 80000,
    // 熔断后是否自动注入「继续当前任务」指令
    autoContinue: true,
    // 退化循环：尾部窗口内同一短语连续重复次数阈值
    repeatThreshold: 3,
    // 退化循环：重复单元最大长度（41-80 字的单元重复 3 次同样异常，原上限 40 会漏检）
    repeatUnitMax: 80,
    // 退化循环：N-gram 密度检测
    gramWindow: 600,
    gramSize: 6,
    gramDensity: 0.16,
    gramMinDistinct: 40,
    // 退化循环：句子级模板重复（对「固定模板 + 小变化」的自我催促有效）
    sentenceRepeatRatio: 0.6,
    sentenceMinPeak: 8,
    sentenceMinParts: 10,
    // 退化循环：稀疏复读（跨大窗口的短句高次重复，不要求连续）
    // 命中场景：thinking 里每隔几百字插一句「好。执行。」这类自我催促
    sparseWindow: 4000,
    sparseMaxUnit: 12,
    sparseMinCount: 5,
    sparseMinRatio: 0.15,
    sparseMinTotal: 6,
    // 每累积多少字符做一次退化检查
    checkEveryChars: 1024,
    // 是否向会话注入说明
    notify: true,
    verbose: false,
};

let createUserMessage = null;

// harness 包不在用户插件的解析路径上，按候选顺序显式解析。
// 路径由 homedir() / DSH_HOME 推导，不硬编码具体用户名——
// 否则安装路径会随包分发，泄露维护者的本机目录结构。
const LLM_CANDIDATES = [
    process.env.DSH_HOME
        ? join(process.env.DSH_HOME, 'profiles/node_modules/@deepseek-ai/dsh-llm/lib/index.js')
        : null,
    join(homedir(), '.dsh/profiles/node_modules/@deepseek-ai/dsh-llm/lib/index.js'),
    '/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh-llm/lib/index.js',
].filter(Boolean);

async function resolveMessageFactory() {
    for (const candidate of LLM_CANDIDATES) {
        try {
            // Windows 上必须转成 file:// URL：默认 ESM loader 拒绝原生绝对路径
            // （ERR_UNSUPPORTED_ESM_URL_SCHEME），否则消息工厂永远解析不到，
            // 熔断说明与自动继续指令会静默失效。
            const mod = await import(pathToFileURL(candidate).href);
            if (typeof mod.createUserMessage === 'function') return mod.createUserMessage;
        } catch {
            // 试下一个候选
        }
    }
    return null;
}

function mergeConfig(raw) {
    const cfg = { ...DEFAULTS, ...(raw ?? {}) };
    // 环境变量可覆盖，便于不改配置文件调参
    const env = (k) => process.env[k];
    if (env('DSH_THINKING_GUARD_DISABLED') === '1') cfg.enabled = false;
    // 每项带下界：低于它判据就失去意义（例如 repeatThreshold < 2 意味着
    // 「重复 1 次」即熔断，任何文本都会被误杀）。
    const numeric = [
        ['DSH_THINKING_ONLY_MS', 'thinkingOnlyMs', 1000],
        ['DSH_MAX_THINKING_CHARS', 'maxThinkingChars', 1000],
        ['DSH_THINKING_REPEAT_THRESHOLD', 'repeatThreshold', 2],
    ];
    for (const [envKey, cfgKey, min] of numeric) {
        const value = Number(env(envKey));
        if (Number.isFinite(value) && value >= min) cfg[cfgKey] = value;
    }
    if (env('DSH_THINKING_GUARD_VERBOSE') === '1') cfg.verbose = true;
    return cfg;
}

/**
 * 结构化内容（代码块、表格、JSON、命令行、清单项）天然含大量同构行，
 * 数字归一化后会被误判成「模板复读」。判重前先剥离这些行，只留自然语言——
 * 真阳性（自我催促式复读）始终表现为自然语言短句，不受影响。
 */
const INDENTED_LINE = /^(\t| {2,})\S/;
const STRUCTURAL_LINE = /^(```|\||[-+*]\s*[-+|:]|[{}\[\]<>]|\.{3,}|={3,}|-{3,})/;
const LIST_ITEM_LINE = /^([-*+]|\d+[.)])\s+/;
const CODEY_NO_CJK = (t) => !/[\u4e00-\u9fa5]/.test(t) && /[;{}$=()<>[\]]/.test(t);

export function stripStructural(text) {
    return (text ?? '')
        .split('\n')
        .filter((line) => {
            const t = line.trim();
            if (t === '') return false;
            if (INDENTED_LINE.test(line)) return false;
            if (STRUCTURAL_LINE.test(t)) return false;
            if (LIST_ITEM_LINE.test(t)) return false;
            if (CODEY_NO_CJK(t)) return false;
            return true;
        })
        .join('\n');
}

/**
 * 退化循环检测：三档互补指标，任一命中即判定退化。
 *   1) 尾部精确重复单元 —— 抓严格复读
 *   2) 句子级模板重复   —— 抓「固定模板 + 小变化」的自我催促
 *   3) N-gram 密度       —— 抓低信息密度的原地打转
 * 输入先经 stripStructural 剥离程序性内容，避免结构化输出被误判为复读。
 */
export function detectDegenerate(text, cfg) {
    const natural = stripStructural(text);
    const window = natural.slice(-cfg.gramWindow);
    if (window.trim().length < 120) return null;

    // 1) 尾部精确重复单元：从短到长找第一个满足阈值的最小单元
    for (let unit = 4; unit <= cfg.repeatUnitMax; unit += 1) {
        let count = 1;
        let cursor = window.length - unit;
        while (cursor - unit >= 0 && window.slice(cursor - unit, cursor) === window.slice(cursor, cursor + unit)) {
            count += 1;
            cursor -= unit;
        }
        if (count >= cfg.repeatThreshold) {
            return { kind: 'repeat-unit', unit: window.slice(window.length - unit), count };
        }
    }

    // 2) 句子级模板重复：数字归一化后统计句模占比
    const normalized = window.replace(/\d+/g, '#').replace(/[ \t]+/g, '');
    const parts = normalized
        .split(/(?<=[。！？!?.\n])/)
        .map((part) => part.trim())
        .filter((part) => part.length >= 4);
    if (parts.length >= cfg.sentenceMinParts) {
        const freq = new Map();
        for (const part of parts) freq.set(part, (freq.get(part) ?? 0) + 1);
        let peak = 0;
        let peakPart = '';
        for (const [part, count] of freq) {
            if (count > peak) {
                peak = count;
                peakPart = part;
            }
        }
        const ratio = peak / parts.length;
        if (peak >= cfg.sentenceMinPeak && ratio >= cfg.sentenceRepeatRatio) {
            return {
                kind: 'sentence-repeat',
                sample: peakPart.slice(0, 40),
                count: peak,
                ratio: Number(ratio.toFixed(3)),
            };
        }
    }

    // 3) 稀疏复读：大窗口内短句高次重复（不要求连续）
    //    覆盖「实质分析与自我催促交替出现」的形态——这类复读在 600 字窗口里
    //    密度不够，前三档全部漏检。
    const bigWindow = natural.slice(-cfg.sparseWindow);
    const shortParts = bigWindow
        .split(/(?<=[。！？!?.\n])/)
        .map((part) => part.trim())
        .filter((part) => part.length >= 2 && part.length <= cfg.sparseMaxUnit)
        // 纯符号片段（Markdown 的 ** / --- / >>> 等）不构成「短句复读」。
        // 线上累计把 ** 当成短句统计到 8-11 次并误熔断，故要求至少含一个字/字母/数字。
        .filter((part) => /[\p{L}\p{N}]/u.test(part));
    if (shortParts.length >= cfg.sparseMinTotal) {
        const shortFreq = new Map();
        for (const part of shortParts) shortFreq.set(part, (shortFreq.get(part) ?? 0) + 1);
        let peak = 0;
        let peakPart = '';
        for (const [part, count] of shortFreq) {
            if (count > peak) {
                peak = count;
                peakPart = part;
            }
        }
        const share = peak / shortParts.length;
        if (peak >= cfg.sparseMinCount && share >= cfg.sparseMinRatio) {
            return {
                kind: 'sparse-repeat',
                sample: peakPart.slice(0, 24),
                count: peak,
                share: Number(share.toFixed(4)),
            };
        }
    }

    // 4) N-gram 密度：最高频 gram 占比过高说明文本在原地打转
    const grams = new Map();
    for (let i = 0; i + cfg.gramSize <= window.length; i += 1) {
        const gram = window.slice(i, i + cfg.gramSize);
        grams.set(gram, (grams.get(gram) ?? 0) + 1);
    }
    if (grams.size >= cfg.gramMinDistinct) {
        let peak = 0;
        for (const count of grams.values()) if (count > peak) peak = count;
        const density = peak / grams.size;
        if (density >= cfg.gramDensity) return { kind: 'gram-density', density: Number(density.toFixed(3)), peak };
    }

    return null;
}

/** 追加尾部文本并按最大窗口截断；稀疏复读需要比句窗更大的缓冲，
 *  否则声明 4000 字的窗口实际只有 gramWindow*2（1200）字。 */
function pushTail(st, text, cfg) {
    const limit = Math.max(cfg.gramWindow * 2, cfg.sparseWindow);
    st.tail = (st.tail + text).slice(-limit);
}

function formatNotice(reason, detail, st, cfg) {
    const head = '[thinking-guard] 已中止当前活动：检测到纯思考空转。';
    const tail = '请停止自我催促式思考，直接输出结论或调用工具推进任务。';
    const stats = `（本回合 reasoning ${st.reasoningChars} 字符，text ${st.textChars} 字符，工具调用 ${st.toolCalls} 次）`;
    switch (reason) {
        case 'thinking-only-timeout':
            return `${head}\n原因：连续 ${Math.round(detail.heldMs / 1000)} 秒只产出思考内容，没有任何回复文本或工具调用。${stats}\n${tail}`;
        case 'thinking-volume':
            return `${head}\n原因：单次尝试思考内容已达 ${detail.chars} 字符，仍无回复文本或工具调用。${stats}\n${tail}`;
        case 'degenerate-loop': {
            let why;
            if (detail.kind === 'repeat-unit') why = `短语「${detail.unit}」连续重复 ${detail.count} 次`;
            else if (detail.kind === 'sentence-repeat') why = `句模「${detail.sample}」重复 ${detail.count} 次（占比 ${detail.ratio}）`;
            else if (detail.kind === 'sparse-repeat') why = `短句「${detail.sample}」在最近 ${cfg.sparseWindow} 字内出现 ${detail.count} 次（稀疏复读）`;
            else why = `6-gram 密度 ${detail.density}`;
            return `${head}\n原因：思考内容陷入重复循环（${why}）。${stats}\n${tail}`;
        }
        default:
            return `${head}${stats}\n${tail}`;
    }
}

export function apply(ctx, config) {
    const cfg = mergeConfig(config);
    const states = new Map();

    // 异步准备消息工厂；失败只是失去可见提示，不影响熔断本身。
    resolveMessageFactory().then((factory) => {
        createUserMessage = factory;
        if (cfg.verbose) {
            console.log(`[thinking-guard] 消息工厂 ${factory ? '已就绪' : '不可用（降级为仅日志）'}`);
        }
    });

    const log = (...args) => {
        if (cfg.verbose) console.log('[thinking-guard]', ...args);
    };

    function notify(agent, text) {
        if (!cfg.notify) return;
        try {
            if (createUserMessage === null) return;
            const message = createUserMessage({
                content: [{ type: 'text', text }],
                // v4 消息格式只接受 producer-owned 的 source.kind（user / model /
                // tool / system-prompt 等）。'plugin' 会让写入校验失败，整轮报
                // "format v4 message requires a producer-owned source kind"。
                // 因此以 user 身份注入，来源标识保留在正文前缀里。
                source: { kind: 'user' },
            });
            agent.followup(message);
            log('已注入熔断说明');
        } catch (error) {
            log('注入说明失败：', error?.message ?? error);
        }
    }

    // 熔断后自动继续当前任务：注入一条"继续"指令，要求立即以工具调用恢复。
    function notifyContinue(agent, reason) {
        try {
            if (createUserMessage === null) return;
            const message = createUserMessage({
                content: [{
                    type: 'text',
                    text: '继续。上一回合因思考空转被熔断中止（' + reason + '）。'
                        + '现在立即恢复原有任务，不要重述背景、不要写长篇思考：'
                        + '本回合第一个动作必须是工具调用；先做一件可验证的小事（读文件、跑命令、查状态），再根据结果继续。',
                }],
                source: { kind: 'user' },
            });
            agent.followup(message);
            log('已注入自动继续指令');
        } catch (error) {
            log('注入自动继续指令失败：', error?.message ?? error);
        }
    }

    function trip(agent, st, reason, detail) {
        if (st.fired) return;
        st.fired = true;
        console.warn(`[thinking-guard] 熔断 ${reason} session=${st.sessionId} turn=${st.turn} step=${st.step} detail=${JSON.stringify(detail)}`);
        // 关键动作优先：cancel 必须先于通知文本生成。
        // 曾出现过的故障：formatNotice 抛 ReferenceError 后 cancel 永不执行，
        // 熔断静默失效（且 st.fired 已置位，本 attempt 后续检测全部跳过）。
        try {
            // keepInbox 默认 false：清掉待处理输入后中止当前活动，避免残留。
            // cause.kind 必须落在 harness 的封闭联合内（user|parent|disposed|hook）：
            // dsh-agent-loop 的 abortedCancelCause() 对未知 kind 走 assertNever 抛错，
            // 会让 turnEnds 停在 null，最终写出 reason:null 的 turn/end，
            // 前后端读该字段随即抛错，会话被渲染成白屏。
            agent.cancel({ kind: 'hook', reason: `thinking-guard:${reason}` });
        } catch (error) {
            console.warn('[thinking-guard] cancel 失败：', error?.message ?? error);
        }
        // 通知属尽力而为：生成失败也要降级为一条最小说明，不能影响已完成的熔断。
        let text;
        try {
            text = formatNotice(reason, detail, st, cfg);
        } catch (error) {
            text = `[thinking-guard] 已中止当前活动：检测到纯思考空转。\n原因：${reason}`
                + `（说明文本生成失败：${error?.message ?? error}）`;
            console.warn('[thinking-guard] 通知文本生成失败，已降级：', error?.message ?? error);
        }
        notify(agent, text);
        if (cfg.autoContinue !== false) notifyContinue(agent, reason);
    }

    function evaluate(agent, st) {
        if (st.fired) return;
        const noProgress = st.textChars === 0 && st.toolCalls === 0;

        // 绝对容量上限：不依赖是否已有产出。模型先吐一小段文本再无限思考，
        // 同样会耗尽资源，因此这条必须独立生效。
        if (st.reasoningChars >= cfg.maxThinkingChars) {
            trip(agent, st, 'thinking-volume', { chars: st.reasoningChars });
            return;
        }

        if (noProgress && st.reasoningChars > 0) {
            // 停滞时长锚定「最后一次进展」，而非 attempt 起点：
            // 已产出 text/tool-call 的回合不会因早期延迟被误判。
            const heldMs = Date.now() - st.lastProgressAt;
            if (heldMs >= cfg.thinkingOnlyMs) {
                trip(agent, st, 'thinking-only-timeout', { heldMs });
                return;
            }
        }

        // 有进展的回合同样要防退化循环：空转既可以是纯思考，也可以是
        // 反复输出同段落而不推进任务。
        if (st.sinceCheck >= cfg.checkEveryChars) {
            st.sinceCheck = 0;
            const hit = detectDegenerate(st.tail, cfg);
            if (hit !== null) trip(agent, st, 'degenerate-loop', hit);
        }
    }

    function onStream(payload) {
        if (!cfg.enabled) return;
        const agent = payload?.agent;
        const frame = payload?.frame;
        // == null 同时覆盖 undefined 与 null：只判 undefined 会让 {agent:null}
        // 之类的载荷在下面读属性时抛 TypeError 并在事件总线内逃逸。
        if (agent == null || frame == null) return;

        const sessionId = agent.session?.id;
        if (typeof sessionId !== 'string') return;

        if (frame.type === 'start') {
            const prev = states.get(sessionId);
            // 同一 attempt 重复收到 start 时不要重置计时锚点：
            // 否则连续 start 会把「零产出时长」反复归零，thinkingOnlyMs 永不触发。
            if (prev !== undefined && prev.attemptId === frame.attemptId) return;
            states.set(sessionId, {
                sessionId,
                attemptId: frame.attemptId,
                turn: frame.turn,
                step: frame.step,
                startedAt: Date.now(),
                lastProgressAt: Date.now(),
                reasoningChars: 0,
                textChars: 0,
                toolCalls: 0,
                tail: '',
                sinceCheck: 0,
                fired: false,
            });
            return;
        }

        if (frame.type === 'end') {
            states.delete(sessionId);
            return;
        }

        if (frame.type !== 'chunk') return;

        const st = states.get(sessionId);
        if (st === undefined || st.fired) return;

        const chunk = frame.chunk;
        if (chunk === undefined || typeof chunk.type !== 'string') return;

        switch (chunk.type) {
            case 'reasoning-delta': {
                const text = typeof chunk.text === 'string' ? chunk.text : '';
                if (text === '') return;
                st.reasoningChars += text.length;
                st.sinceCheck += text.length;
                pushTail(st, text, cfg);
                break;
            }
            case 'text-delta': {
                const text = typeof chunk.text === 'string' ? chunk.text : '';
                if (text.trim() !== '') {
                    st.textChars += text.length;
                    st.lastProgressAt = Date.now();
                    // 文本同样进入退化窗口：反复输出同段文本也是空转
                    st.sinceCheck += text.length;
                    pushTail(st, text, cfg);
                    break;   // 落到 evaluate：文本退化同样要检查
                }
                return;
            }
            case 'tool-call-delta':
                st.toolCalls += 1;
                st.lastProgressAt = Date.now();
                return;
            case 'block-start':
                // 出现 text / tool-call 块即视为已产生进展
                if (chunk.blockType === 'tool-call') {
                    st.toolCalls += 1;
                    st.lastProgressAt = Date.now();
                } else if (chunk.blockType === 'text') {
                    st.lastProgressAt = Date.now();
                }
                return;
            default:
                return;
        }

        evaluate(agent, st);
    }

    // global：会话以编程方式创建的 agent 同样纳入熔断
    ctx.on('agent/assistant-stream', onStream, { global: true });

    ctx.on('agent/disposed', ({ agent }) => {
        const sessionId = agent?.session?.id;
        if (typeof sessionId === 'string') states.delete(sessionId);
    }, { global: true });

    ctx.effect(() => () => states.clear(), 'thinking-guard.state');

    log(`已启用：thinkingOnlyMs=${cfg.thinkingOnlyMs} maxThinkingChars=${cfg.maxThinkingChars} repeatThreshold=${cfg.repeatThreshold}`);
}
