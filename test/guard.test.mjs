// 相对本文件解析，避免写死安装位置（否则随包分发会泄露维护者的本机目录）
const mod = await import(new URL('../lib/index.js', import.meta.url).href);
function h(config) {
  const handlers = new Map();
  mod.apply({ on: (e, f) => handlers.set(e, f), effect: (f) => f() }, config);
  const events = []; let rev = 0, idx = 0;
  const agent = { session: { id: 's' }, cancel: (c) => events.push({ type: 'cancel', cause: c }), followup: (m) => events.push({ type: 'followup', message: m }) };
  return {
    start: () => handlers.get('agent/assistant-stream')({ agent, frame: { type:'start', attemptId:'a', revision:++rev, turn:1, step:1 } }),
    chunk: (c) => handlers.get('agent/assistant-stream')({ agent, frame: { type:'chunk', attemptId:'a', revision:++rev, index:idx++, time:Date.now(), chunk:c } }),
    tripped: () => events.find((e) => e.type === 'cancel'),
    injections: () => events.filter((e) => e.type === 'followup'),
  };
}
let pass=0, fail=0;
const check=(l,g,w)=>{const ok=g===w; ok?pass++:fail++; console.log(`[${ok?'PASS':'FAIL'}] ${l}  熔断=${g} 期望=${w}`);};

// 1 纯思考超时
{ const t=h({thinkingOnlyMs:60,checkEveryChars:1e9,notify:false}); t.start();
  await new Promise(r=>setTimeout(r,80));
  for(let i=0;i<5;i++) t.chunk({type:'reasoning-delta',index:0,text:`思考片段 ${i}，仍未形成结论。`});
  check('场景1 纯思考超时',!!t.tripped(),true); }

// 2 YG 样本复读
{ const t=h({thinkingOnlyMs:1e9,checkEveryChars:1,notify:false}); t.start();
  const s='好。执行。好。（输出工具调用）'.repeat(12);
  for(let i=0;i<s.length;i+=20) t.chunk({type:'reasoning-delta',index:0,text:s.slice(i,i+20)});
  check('场景2 退化循环复读',!!t.tripped(),true); }

// 3 容量上限
{ const t=h({thinkingOnlyMs:1e9,maxThinkingChars:300,checkEveryChars:1e9,notify:false}); t.start();
  for(let i=0;i<20;i++) t.chunk({type:'reasoning-delta',index:0,text:'一段没有结论的思考内容，持续消耗资源而无任何产出。'});
  check('场景3 思考容量上限',!!t.tripped(),true); }

// 4 正常回合（每轮内容不同，逼近真实）
{ const t=h({thinkingOnlyMs:60,maxThinkingChars:300,checkEveryChars:1,notify:false}); t.start();
  for(let i=0;i<12;i++){
    t.chunk({type:'reasoning-delta',index:0,text:`第 ${i} 步需要先确认目标服务的版本信息。`});
    t.chunk({type:'text-delta',index:1,text:`正在处理第 ${i} 项检查，结果已记录到证据文件。`});
  }
  check('场景4 正常回合放行',!!t.tripped(),false); }

// 5 工具调用
{ const t=h({thinkingOnlyMs:60,maxThinkingChars:300,checkEveryChars:1,notify:false}); t.start();
  for(let i=0;i<12;i++){ t.chunk({type:'reasoning-delta',index:0,text:'准备调用工具。'}); t.chunk({type:'tool-call-delta',index:1,id:'c',name:'bash',argumentsDelta:'{"command":' }); }
  check('场景5 工具调用放行',!!t.tripped(),false); }

// 6 有产出后短思考
{ const t=h({thinkingOnlyMs:1e9,maxThinkingChars:1e9,checkEveryChars:1,notify:false}); t.start();
  t.chunk({type:'text-delta',index:1,text:'已输出一段正式回复。'});
  await new Promise(r=>setTimeout(r,80));
  for(let i=0;i<5;i++) t.chunk({type:'reasoning-delta',index:0,text:'继续思考但没有新产出。'});
  check('场景6 有产出后短思考放行',!!t.tripped(),false); }

// 7 正常结束（各句实质不同）
{ const t=h({thinkingOnlyMs:1e9,maxThinkingChars:1e9,checkEveryChars:1,notify:false}); t.start();
  const lines=['先确认服务端口与协议。','检查证书链的颁发者字段。','比对中国件响应头顺序。','核对错误页模板哈希。','记录归属判定依据。','标注仍需复核的条目。','换一条路径扩展侦察。','汇总证据链后收束。','整理未完成事项清单。','输出最终结论与建议。'];
  for(const line of lines) t.chunk({type:'text-delta',index:1,text:line});
  t.chunk({type:'finish',reason:{kind:'stop'}});
  check('场景7 正常结束放行',!!t.tripped(),false); }

// 8 有产出仍限容量
{ const t=h({thinkingOnlyMs:1e9,maxThinkingChars:400,checkEveryChars:1e9,notify:false}); t.start();
  t.chunk({type:'text-delta',index:1,text:'先输出一小段文本。'});
  for(let i=0;i<20;i++) t.chunk({type:'reasoning-delta',index:0,text:'随后陷入无限思考，继续消耗而不产出结论。'});
  check('场景8 有产出仍限容量',!!t.tripped(),true); }

// 9 文本复读
{ const t=h({thinkingOnlyMs:1e9,maxThinkingChars:1e9,checkEveryChars:1,notify:false}); t.start();
  const s='正在重新整理思路，稍后输出。'.repeat(20);
  for(let i=0;i<s.length;i+=25) t.chunk({type:'text-delta',index:1,text:s.slice(i,i+25)});
  check('场景9 文本复读熔断',!!t.tripped(),true); }

// 10 长正常技术文本
{ const t=h({thinkingOnlyMs:1e9,maxThinkingChars:1e9,checkEveryChars:1,notify:false}); t.start();
  const para=['先确认目标服务的监听端口与证书链。','再比对中国件指纹，包括响应头顺序与错误页哈希。','随后核对静态资源路径的命名习惯，判断归属。','综合以上证据后记录确认方法，并标注待复核项。','如果证据不足则扩展侦察角度，换一条路径重新验证。'];
  for(let r=0;r<4;r++) for(const p of para) t.chunk({type:'text-delta',index:1,text:p});
  check('场景10 长正常文本放行',!!t.tripped(),false); }

// 11 稀疏复读（跨大窗口短句高次重复，前三档在 600 字窗口内密度不足会漏检）
// 回归用例：此档曾因 formatNotice 引用模块级 cfg 抛 ReferenceError，
// 导致 cancel 永不执行、熔断静默失效（线上日志累计 500+ 次）。
{ const t=h({thinkingOnlyMs:1e9,maxThinkingChars:1e9,checkEveryChars:1,notify:false}); t.start();
  const parts=[]; for(let i=0;i<12;i++) parts.push('好。执行。', `第 ${i} 段实质不同的分析内容，用于拉开窗口距离。`);
  const s=parts.join('');
  let threw=null;
  for(let i=0;i<s.length;i+=40){ try{ t.chunk({type:'reasoning-delta',index:0,text:s.slice(i,i+40)}); }catch(e){ threw=e; break; } }
  check('场景11 稀疏复读熔断且不抛异常', threw===null && !!t.tripped(), true); }

// 12 cancel cause 契约：dsh-agent-loop 的 abortedCancelCause() 只认
// user|parent|disposed|hook 四个 kind，未知 kind 会走 assertNever 抛错，
// turnEnds 随即停在 null 并写出 reason:null 的 turn/end —— 前后端读该
// 字段都抛 TypeError，会话被渲染成白屏（2026-10-17 线上三次熔断全部命中）。
{ const t=h({thinkingOnlyMs:60,checkEveryChars:1e9,notify:false}); t.start();
  await new Promise(r=>setTimeout(r,80));
  for(let i=0;i<5;i++) t.chunk({type:'reasoning-delta',index:0,text:`思考片段 ${i}，仍未形成结论。`});
  const cause=t.tripped()?.cause;
  const legal=['user','parent','disposed','hook'];
  check('场景12 cancel cause 落在封闭联合内',legal.includes(cause?.kind),true); }

// 13 结构化输出不得误熔断：代码块 / 表格 / 清单天然含大量同构行，
//    数字归一化后会变成「同一句」，曾因此被 sentence-repeat 判为模板复读。
{ const t=h({thinkingOnlyMs:1e9,maxThinkingChars:1e9,checkEveryChars:1,notify:false}); t.start();
  const code='下面给出修改后的代码。\n```js\n'+Array.from({length:20},(_,i)=>`if (flag${i}) return null;`).join('\n')+'\n```';
  const table='| 项目 | 状态 |\n|---|---|\n'+Array.from({length:15},(_,i)=>`| 检查项${i} | 正常 |`).join('\n');
  const list=Array.from({length:20},(_,i)=>`- [ ] 完成第 ${i} 项检查并记录结果`).join('\n');
  t.chunk({type:'text-delta',index:1,text:code+'\n'+table+'\n'+list});
  check('场景13 结构化输出放行',!!t.tripped(),false); }

// 14 模板型复读仍须熔断：仅数字不同、语义相同的空模板是典型空转形态。
{ const t=h({thinkingOnlyMs:1e9,maxThinkingChars:1e9,checkEveryChars:1,notify:false}); t.start();
  const s=Array.from({length:20},(_,i)=>`第 ${i} 步要处理的是与前面都不同的第 ${i*7} 项内容。`).join('');
  t.chunk({type:'reasoning-delta',index:0,text:s});
  check('场景14 模板型复读熔断',!!t.tripped(),true); }

// 15 复读落在代码行内 → 设计上放行（结构化内容判重前被剥离，宁可漏报不误报）
{ const t=h({thinkingOnlyMs:1e9,maxThinkingChars:1e9,checkEveryChars:1,notify:false});
  t.start();
  t.chunk({type:'text-delta',index:1,text:'\`\`\`js\n'+'if (flag) return null;\n'.repeat(12)+'\`\`\`'});
  check('场景15 代码行内复读按设计放行',!!t.tripped(),false); }

// 16 中长重复单元（41-80 字）应被检出——原上限 40 会漏检
{ const t=h({thinkingOnlyMs:1e9,maxThinkingChars:1e9,checkEveryChars:1,notify:false});
  t.start();
  const unit='一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十';  // 45 字
  t.chunk({type:'reasoning-delta',index:0,text:unit.repeat(3)});
  check('场景16 中长重复单元检出',!!t.tripped(),true); }

// 17 默认节流（checkEveryChars=1024）下仍能熔断——此前全部用例都传 1，生产路径零覆盖
{ const t=h({thinkingOnlyMs:1e9,maxThinkingChars:1e9,notify:false});
  t.start();
  for(let i=0;i<140;i++) t.chunk({type:'reasoning-delta',index:0,text:'正在重新整理思路，稍后输出。'});
  check('场景17 默认节流下熔断',!!t.tripped(),true); }

// 18 通知链路：消息工厂可用时应注入熔断说明与自动继续指令
{ const t=h({thinkingOnlyMs:1e9,maxThinkingChars:1e9,checkEveryChars:1,notify:true,autoContinue:true});
  await new Promise(r=>setTimeout(r,700));   // 等 resolveMessageFactory 异步完成
  t.start();
  t.chunk({type:'reasoning-delta',index:0,text:'先确认监听端口与证书链是否一致，再比对中国件指纹来判断归属。随后核对静态资源命名习惯，如果证据不足就换一条路径重新验证。综合以上线索后记录确认方法并标注待复核项。'+'好。执行。'.repeat(12)});
  const n=t.injections().length;
  const legal=t.injections().every(i=>i.message?.source?.kind==='user');
  if(process.env.DSH_HOME) check('场景18 熔断注入说明与继续指令',n>=1&&legal,true);
  else console.log(`[SKIP] 场景18 通知链路（未设 DSH_HOME，消息工厂不可用；实机注入数=${n}）`); }

// 19 Markdown 加粗标记 ** 不得被当成短句复读（线上累计误熔断 3 次）
{ const t=h({thinkingOnlyMs:1e9,maxThinkingChars:1e9,checkEveryChars:1,notify:false});
  t.start();
  let s='';
  for(let i=0;i<14;i++) s+=`**第 ${i} 点**\n这一条讲的是与前面完全不同的具体事项 ${i}。\n`;
  t.chunk({type:'reasoning-delta',index:0,text:s});
  check('场景19 Markdown 标记不计入复读',!!t.tripped(),false); }

console.log(`\n合计：${pass} 通过 / ${fail} 失败`);
process.exit(fail===0?0:1);
