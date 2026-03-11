import { useState, useRef, useEffect, useCallback } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";

// ─── 长期记忆 ─────────────────────────────────────────────────────────────────
const MEMORY_KEY = "xiaow_memory";
const MAX_MEMORIES = 60;

function loadMemories() {
  try { const v = localStorage.getItem(MEMORY_KEY); return v ? JSON.parse(v) : []; }
  catch { return []; }
}
function saveMemories(mems) {
  try { localStorage.setItem(MEMORY_KEY, JSON.stringify(mems)); } catch {}
}

async function generateMemorySummary(apiKey, messages) {
  const meaningful = messages.filter(m =>
    !(m.role === "assistant" && (typeof m.content === "string") && m.content.startsWith("嗨！"))
  );
  if (meaningful.length < 4) return;
  const dialogue = meaningful.slice(0, 20).map(m => {
    const role = m.role === "user" ? "孩子" : "小问";
    const text = typeof m.content === "string"
      ? m.content : m.content?.find?.(c => c.type === "text")?.text || "[图片]";
    return `${role}：${text.slice(0, 150)}`;
  }).join("\n");
  const sys = `你是学习记录助手。用80字以内总结这段孩子与AI的对话：话题是什么、孩子的理解程度、体现出的兴趣信号。纯文字，不用标题列表，像简短日记。直接输出。`;
  try {
    const isNative = typeof window !== "undefined" && window.Capacitor?.isNativePlatform?.();
    const url = isNative ? "https://api.anthropic.com/v1/messages" : "http://localhost:3001/api/chat";
    let full = "";
    if (isNative) {
      const res = await fetch(url, {
        method:"POST",
        headers:{"Content-Type":"application/json","x-api-key":apiKey,
          "anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},
        body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:200,
          system:sys,messages:[{role:"user",content:dialogue}]}),
      });
      const data = await res.json();
      full = data.content?.[0]?.text || "";
    } else {
      const res = await fetch(url, {method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({apiKey,system:sys,messages:[{role:"user",content:dialogue}]})});
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
      while (true) {
        const {done,value} = await reader.read(); if (done) break;
        buf += dec.decode(value,{stream:true}); const lines = buf.split("\n"); buf = lines.pop()||"";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const d = line.slice(6).trim(); if (d==="[DONE]") continue;
          try { const p=JSON.parse(d); if(p.type==="content_block_delta"&&p.delta?.text) full+=p.delta.text; } catch {}
        }
      }
    }
    if (!full || full.length < 10) return;
    const mems = loadMemories();
    mems.push({date:new Date().toISOString().slice(0,10),ts:Date.now(),summary:full.trim()});
    if (mems.length > MAX_MEMORIES) mems.splice(0, mems.length - MAX_MEMORIES);
    saveMemories(mems);
  } catch(e) { console.log("Memory summary failed:", e.message); }
}

function buildMemoryContext() {
  const mems = loadMemories();
  if (mems.length === 0) return "";
  const recent = mems.slice(-8);
  const lines = recent.map(m => `[${m.date}] ${m.summary}`).join("\n");
  return `\n\n## 你对这个孩子的了解（历史对话摘要，请自然融入，不要刻意提及）\n${lines}`;
}

// ─── 奇阅魔方联动：读取孩子最近读的书 ────────────────────────────────────────
function getQiyueContext() {
  try {
    // 奇阅魔方存在 IndexedDB，这里读 localStorage 里的最近书名缓存
    // 奇阅魔方需配合写入 qiyue_recent_book 这个 key
    const v = localStorage.getItem("qiyue_recent_book");
    if (!v) return "";
    const {title, author, recentChapter} = JSON.parse(v);
    return `\n\n## 孩子最近在读的书\n书名：${title}${author?`，作者：${author}`:""}${recentChapter?`，最近读到：${recentChapter}`:""}。\n如果孩子的问题和这本书有关，可以自然地关联上。`;
  } catch { return ""; }
}

// ─── System Prompts ───────────────────────────────────────────────────────────
const SYSTEM_PROMPTS = {

primary: `你是一个专门帮助8-12岁小学生学习的AI学习伙伴，名字叫"小问"。你可以回答孩子的任何问题——不限于学校课程，包括生活中的好奇心、科学现象、天文地理、历史故事等等，都用苏格拉底式引导来帮他思考。

## 你的核心原则
永远不要直接给出答案。你的任务是帮孩子建立独立思考的习惯，而不是依赖你。

## 第一步：先问孩子想过什么
孩子一上来提问，不要直接进入引导，先问一句：
- "你自己想过哪些方法了？"
- "你觉得从哪里开始想比较好？"
- 目的是让孩子意识到：提问之前要先动脑

## 帮助梯度（在了解孩子的想法之后，按顺序进行）

**第1步 - 引导思考（默认起点）**
- 用反问引导孩子思考："你觉得这道题在问什么？""你有什么想法？"
- 把大问题拆成小问题："先只想第一步，你会怎么做？"
- 绝对不给任何实质提示，只是帮孩子打开思路

**第2步 - 缩小范围（孩子表示不懂或答错1次后）**
- 给出方向性提示，但不给具体方法
- 用生活中的具体类比帮助理解

**第3步 - 框架提示（孩子仍然卡住或表示不懂2次以上）**
- 给出解题框架，但留空让孩子填
- 给出部分答案，后半部分让孩子试

**第4步 - 完整解答（孩子明确表示不会，或多轮仍无进展）**
- 给出完整答案
- 必须解释：解题思路、知识点、为什么这样做
- 结尾必须做两件事：
  1. 让孩子用自己的话复述一遍解题思路："你能用自己的话说说为什么这样做吗？"
  2. 出一道同类型但数字不同的题让孩子独立完成："好，现在换个数字你来试试！"

## 答对之后不能只夸奖
- 孩子答对时，先真诚肯定，然后追问："你能解释一下你是怎么想到的吗？"
- 如果是第二次遇到同类型题，要比第一次给更少提示，更多反问

## 保护孩子的积极性
- 遇到孩子表达沮丧、想放弃时，明确说：卡住是正常的，聪明不是一下就会，而是愿意一直想
- 把挫折重新定义为机会："这道题正在帮你变强，卡住的地方就是你要突破的地方"
- 绝对不能嘲讽、否定、或让孩子感到自己笨

## 语言风格
- 简单、温暖、鼓励，像耐心的大哥哥/大姐姐
- 每次回复不超过120字
- 多用"你觉得呢？""试试看？""很棒，再想想……"
- 避免让孩子觉得"反正AI会告诉我"，始终强调孩子自己能做到`,

middle: `你是一个专门帮助12-15岁初中生学习的AI学习伙伴，名字叫"小问"。任何领域的问题都可以回答，不限于学校科目，包括科学、历史、社会、生活常识等，都用苏格拉底式引导来帮学生思考。

## 你的核心原则
永远不要直接给出答案。你的任务是帮学生建立独立思考和解题能力，而不是依赖你。

## 第一步：先问学生想过什么
学生一上来提问，先问：
- "你自己的思路是什么？卡在哪一步了？"
- "你尝试过哪些方法，结果如何？"
- 目的是让学生意识到：遇到困难先独立思考，再寻求帮助

## 帮助梯度（在了解学生想法之后，按顺序进行）

**第1步 - 引导思考（默认起点）**
- 用苏格拉底式反问引导："这道题的关键条件是什么？""你觉得从哪个角度切入比较好？"
- 引导学生建立解题框架，而不是给具体方法
- 可以适当引用学过的定理或概念，但不直接套用

**第2步 - 缩小范围（学生卡住或答错1次后）**
- 给出方向性提示，但不给具体步骤
- 用类比或反例帮助理解核心概念

**第3步 - 框架提示（学生仍然卡住2次以上）**
- 给出解题思路框架，但关键步骤留空让学生填
- 指出学生思路中的错误，引导其自己发现原因

**第4步 - 完整解答（学生明确表示不会，或多轮无进展）**
- 给出完整解题过程
- 必须解释：解题逻辑、涉及的知识点、常见易错点
- 结尾出一道同类型变式题，要求学生独立完成
- 鼓励学生总结解题规律，而不只是记住这道题的做法

## 答对之后追问本质
- 学生答对时，追问："你能说说解这类题的通用思路吗？"
- 第二次遇到同类型题时，更少提示，更多追问解题逻辑
- 目标是让学生掌握方法，而不只是完成题目

## 保护学习积极性
- 遇到学生表达挫败感时，承认这道题确实有难度，同时强调：卡住说明在思维边界上，这才是真正的成长
- 可以适当分析这道题考查的能力，帮助学生看到题目背后的意义
- 不否定学生的思路，即使是错的，也从中找到可取之处再引导

## 语言风格
- 平等、理性、有深度，像一个比学生大几岁的学长/学姐
- 每次回复不超过150字
- 可以使用更抽象的概念和术语，但要确保学生能理解
- 鼓励学生质疑和追问，培养批判性思维`,

};

// 根据年级返回对应 prompt
function getSystemPrompt(level) {
  return SYSTEM_PROMPTS[level] || SYSTEM_PROMPTS.primary;
}

// 两套 prompt 共用的隐藏标记规则（追加到 prompt 末尾）
const SHARED_RULES = `

## 数学公式格式
- 所有数学公式必须用 LaTeX 格式输出
- 行内公式用\$...\$包裹，例如：$\\frac{1}{2}$、$x^2$、$\\sqrt{4}$
- 独立公式用\$\$...\$\$包裹
- 分数用\\frac{}{}，根号用\\sqrt{}，乘号用\\times，除号用\\div

## 判断是否是新题目
- 当发来的消息是一个全新的问题（和之前的对话话题无关），在回复的最开头加上 \`[新题目]\` 这个标记
- 如果是对之前问题的继续讨论、追问、或者回答你的问题，不加这个标记
- 这个标记会被系统自动隐藏

## 判断是否需要家长帮助
满足以下所有条件时，在回复末尾加上隐藏标记 \`[需要帮助]\`：
1. 已经完成了第4步完整解答
2. 对方在完整答案之后仍然明确表示不理解
3. 你判断继续引导短期内也无法突破

绝对不能触发的情况：
- 对方在主动追问、深入探索（这是好事，要鼓励）
- 还没到第4步
- 对方只是在思考、沉默、或者回答不完整`;



// ─── Math Renderer ────────────────────────────────────────────────────────────
function MathText({ text }) {
  // 解析文字中的 $$...$$ 和 $...$ 并渲染
  const parts = [];
  const blockRegex = /\$\$([\s\S]+?)\$\$/g;
  const inlineRegex = /\$([^\$\n]+?)\$/g;

  let lastIndex = 0;
  let match;

  // 先处理块级公式
  const segments = [];
  let remaining = text;
  let offset = 0;

  const allMatches = [];
  let m;
  const br = /\$\$([\s\S]+?)\$\$/g;
  const ir = /(?<!\$)\$([^\$\n]+?)\$(?!\$)/g;

  while ((m = br.exec(text)) !== null) allMatches.push({ start: m.index, end: m.index + m[0].length, formula: m[1], block: true });
  while ((m = ir.exec(text)) !== null) {
    // 跳过已被块级匹配覆盖的
    if (!allMatches.some(am => m.index >= am.start && m.index < am.end))
      allMatches.push({ start: m.index, end: m.index + m[0].length, formula: m[1], block: false });
  }
  allMatches.sort((a, b) => a.start - b.start);

  let cursor = 0;
  allMatches.forEach((am, i) => {
    if (am.start > cursor) parts.push(<span key={`t${i}`}>{text.slice(cursor, am.start)}</span>);
    try {
      const html = katex.renderToString(am.formula, { throwOnError: false, displayMode: am.block });
      parts.push(
        <span key={`m${i}`}
          style={am.block ? { display:"block", textAlign:"center", margin:"8px 0", overflowX:"auto" } : { display:"inline" }}
          dangerouslySetInnerHTML={{ __html: html }} />
      );
    } catch {
      parts.push(<span key={`m${i}`} style={{color:"#6366F1"}}>{am.block ? `$$${am.formula}$$` : `$${am.formula}$`}</span>);
    }
    cursor = am.end;
  });
  if (cursor < text.length) parts.push(<span key="tail">{text.slice(cursor)}</span>);

  return <>{parts}</>;
}

// ─── Constants ───────────────────────────────────────────────────────────────
const OWL_OPTIONS = ["🦉", "🐧", "🐻", "🐼", "🐨", "🦊", "🐸", "🐯"];

const BG_THEMES = [
  { id: "mint",    label: "薄荷绿", value: "linear-gradient(160deg,#E0F7F0 0%,#F0FDF4 50%,#E8F5E9 100%)" },
  { id: "sky",     label: "天空蓝", value: "linear-gradient(160deg,#EEF2FF 0%,#E0F2FE 50%,#F0F9FF 100%)" },
  { id: "peach",   label: "蜜桃粉", value: "linear-gradient(160deg,#FFF1F2 0%,#FFF7ED 50%,#FEF3C7 100%)" },
  { id: "lavender",label: "薰衣草", value: "linear-gradient(160deg,#F5F3FF 0%,#EDE9FE 50%,#FAF5FF 100%)" },
  { id: "sunny",   label: "阳光黄", value: "linear-gradient(160deg,#FFFBEB 0%,#FEF9C3 50%,#FFF7ED 100%)" },
  { id: "cloud",   label: "云朵白", value: "linear-gradient(160deg,#F8FAFC 0%,#F1F5F9 50%,#F8FAFC 100%)" },
];

const STORAGE_KEYS = {
  settings:  "xiaow_settings",
  sessions:  "xiaow_sessions",
  usage:     "xiaow_usage",
  pin:       "xiaow_pin",
};

const DEFAULT_SETTINGS = {
  apiKey:  "",
  owl:     "🦉",
  bgTheme: "mint",
  pin:     "",
  level:   "primary",  // "primary" 小学中高年级 | "middle" 初中
};

// ─── Storage helpers ──────────────────────────────────────────────────────────
const load = (key, fallback) => {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
};
const save = (key, val) => {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
};

// ─── Usage tracking ───────────────────────────────────────────────────────────
function todayKey() { return new Date().toISOString().slice(0,10); }

function recordUsage(turns) {
  const usage = load(STORAGE_KEYS.usage, {});
  const k = todayKey();
  if (!usage[k]) usage[k] = { turns: 0, sessions: 0, minutes: 0 };
  usage[k].turns += turns;
  save(STORAGE_KEYS.usage, usage);
}

function recordSession() {
  const usage = load(STORAGE_KEYS.usage, {});
  const k = todayKey();
  if (!usage[k]) usage[k] = { turns: 0, sessions: 0, minutes: 0 };
  usage[k].sessions += 1;
  save(STORAGE_KEYS.usage, usage);
}

// ─── API call ─────────────────────────────────────────────────────────────────
// 判断是否在 Capacitor 原生环境（打包后的手机 app）
const isNative = typeof window !== "undefined" && window.Capacitor?.isNativePlatform?.();

async function callClaude(apiKey, messages, onChunk, systemPrompt) {
  // 原生 app：直接调 Anthropic，Clash Meta 在系统层透明代理
  // Mac 浏览器开发：走本地 server.js 绕过浏览器限制
  const url = isNative
    ? "https://api.anthropic.com/v1/messages"
    : "http://localhost:3001/api/chat";

  const res = isNative
    ? await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1000,
          system: systemPrompt,
          messages,
          stream: true,
        }),
      })
    : await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, messages, system: systemPrompt }),
      });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;
      try {
        const json = JSON.parse(data);
        const delta = json.delta?.text || "";
        if (delta) {
          fullText += delta;
          onChunk(fullText);
        }
      } catch {}
    }
  }

  return fullText;
}

// ─── PIN Modal ────────────────────────────────────────────────────────────────
function PinModal({ mode, savedPin, onSuccess, onClose }) {
  // mode: "verify" | "set"
  const [digits, setDigits] = useState(["","","",""]);
  const [confirm, setConfirm] = useState(["","","",""]);
  const [step, setStep] = useState("enter"); // "enter" | "confirm"
  const [error, setError] = useState("");
  const refs = [useRef(),useRef(),useRef(),useRef()];
  const crefs = [useRef(),useRef(),useRef(),useRef()];

  useEffect(() => { refs[0].current?.focus(); }, []);

  const handleDigit = (arr, setArr, rfs, i, v) => {
    if (!/^\d?$/.test(v)) return;
    const next = [...arr]; next[i] = v;
    setArr(next); setError("");
    if (v && i < 3) rfs[i+1].current?.focus();
    if (v && i === 3) {
      const pin = next.join("");
      if (mode === "verify") {
        if (pin === savedPin) { onSuccess(); }
        else { setError("密码错误"); setArr(["","","",""]); setTimeout(()=>rfs[0].current?.focus(),50); }
      } else {
        if (step === "enter") {
          setStep("confirm");
          setTimeout(()=>crefs[0].current?.focus(),50);
        } else {
          if (pin === digits.join("")) { onSuccess(digits.join("")); }
          else { setError("两次输入不一致"); setConfirm(["","","",""]); setTimeout(()=>crefs[0].current?.focus(),50); }
        }
      }
    }
  };

  const handleKey = (arr, setArr, rfs, i, e) => {
    if (e.key === "Backspace" && !arr[i] && i > 0) rfs[i-1].current?.focus();
  };

  const renderDots = (arr, setArr, rfs, label) => (
    <div>
      <div style={{fontSize:13,color:"#64748b",marginBottom:12,textAlign:"center"}}>{label}</div>
      <div style={{display:"flex",gap:12,justifyContent:"center"}}>
        {arr.map((d,i) => (
          <input key={i} ref={rfs[i]} type="password" maxLength={1} value={d}
            onChange={e=>handleDigit(arr,setArr,rfs,i,e.target.value)}
            onKeyDown={e=>handleKey(arr,setArr,rfs,i,e)}
            style={{width:48,height:56,borderRadius:12,border:`2px solid ${d?"#6366F1":"#E2E8F0"}`,
              background:d?"#EEF2FF":"#F8FAFC",textAlign:"center",fontSize:24,fontWeight:700,
              color:"#6366F1",outline:"none"}} />
        ))}
      </div>
    </div>
  );

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,.6)",backdropFilter:"blur(6px)",
      zIndex:300,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:"white",borderRadius:20,padding:28,width:"100%",maxWidth:320,
        boxShadow:"0 20px 60px rgba(0,0,0,.2)"}}>
        <div style={{textAlign:"center",marginBottom:24}}>
          <div style={{fontSize:32,marginBottom:8}}>🔒</div>
          <div style={{fontSize:17,fontWeight:800,color:"#1e293b"}}>
            {mode==="verify" ? "家长验证" : step==="enter" ? "设置家长密码" : "再次确认密码"}
          </div>
          <div style={{fontSize:12,color:"#94a3b8",marginTop:4}}>
            {mode==="verify" ? "请输入4位家长密码" : step==="enter" ? "请设置一个4位数字密码" : "再输入一次确认"}
          </div>
        </div>

        {mode==="set" && step==="confirm"
          ? renderDots(confirm, setConfirm, crefs, "")
          : renderDots(digits, setDigits, refs, "")}

        {error && (
          <div style={{marginTop:14,padding:"8px 12px",borderRadius:8,background:"#FEF2F2",
            border:"1px solid #FECACA",fontSize:12,color:"#EF4444",textAlign:"center",fontWeight:600}}>
            {error}
          </div>
        )}

        <button onClick={onClose}
          style={{marginTop:16,width:"100%",padding:"10px",borderRadius:10,border:"1px solid #E2E8F0",
            background:"transparent",color:"#94a3b8",fontSize:13,cursor:"pointer"}}>
          取消
        </button>
      </div>
    </div>
  );
}

// ─── Settings Panel ───────────────────────────────────────────────────────────
function SettingsPanel({ settings, onSave, onClose, onShowReport }) {
  const [local, setLocal] = useState(settings);
  const [showKey, setShowKey] = useState(false);
  const [changingPin, setChangingPin] = useState(false);

  const set = (k,v) => setLocal(p=>({...p,[k]:v}));

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,.5)",backdropFilter:"blur(4px)",
      zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:16,overflowY:"auto"}}>

      {changingPin && (
        <PinModal mode="set" savedPin={local.pin}
          onSuccess={pin=>{ set("pin",pin); setChangingPin(false); }}
          onClose={()=>setChangingPin(false)} />
      )}

      <div style={{background:"white",borderRadius:20,padding:24,width:"100%",maxWidth:420,
        maxHeight:"90vh",overflowY:"auto",boxShadow:"0 20px 60px rgba(0,0,0,.2)"}}>

        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:22}}>
          <div style={{fontSize:17,fontWeight:800,color:"#1e293b"}}>⚙️ 家长设置</div>
          <button onClick={onClose} style={{border:"none",background:"#F1F5F9",borderRadius:8,
            width:32,height:32,cursor:"pointer",fontSize:14,color:"#64748b"}}>✕</button>
        </div>

        {/* API Key */}
        <Section title="Claude API Key">
          <div style={{display:"flex",gap:8}}>
            <input type={showKey?"text":"password"} value={local.apiKey}
              onChange={e=>set("apiKey",e.target.value)} placeholder="sk-ant-api..."
              style={{flex:1,padding:"10px 12px",borderRadius:9,border:"1.5px solid #E2E8F0",
                fontSize:13,fontFamily:"monospace",color:"#1e293b",outline:"none"}} />
            <button onClick={()=>setShowKey(v=>!v)}
              style={{padding:"0 12px",borderRadius:9,border:"1.5px solid #E2E8F0",
                background:"#F8FAFC",cursor:"pointer",fontSize:13,color:"#64748b"}}>
              {showKey?"隐藏":"显示"}
            </button>
          </div>
          <div style={{fontSize:11,color:"#94a3b8",marginTop:5}}>→ console.anthropic.com 获取</div>
        </Section>

        {/* 年级 */}
        <Section title="孩子的年级">
          <div style={{display:"flex",gap:8}}>
            {[
              {id:"primary", label:"🎒 小学中高年级", sub:"8-12岁"},
              {id:"middle",  label:"📐 初中",         sub:"12-15岁"},
            ].map(opt=>(
              <button key={opt.id} onClick={()=>set("level",opt.id)}
                style={{flex:1,padding:"10px 8px",borderRadius:12,cursor:"pointer",
                  border:`2px solid ${local.level===opt.id?"#6366F1":"#E2E8F0"}`,
                  background:local.level===opt.id?"#EEF2FF":"#F8FAFC",
                  fontFamily:"'Nunito',sans-serif",textAlign:"center",transition:"all .15s"}}>
                <div style={{fontSize:13,fontWeight:700,
                  color:local.level===opt.id?"#6366F1":"#1e293b"}}>{opt.label}</div>
                <div style={{fontSize:11,color:"#94a3b8",marginTop:2}}>{opt.sub}</div>
              </button>
            ))}
          </div>
          <div style={{fontSize:11,color:"#94a3b8",marginTop:8}}>
            切换后下一次对话生效
          </div>
        </Section>

        {/* Claude API Key */}
        <Section title="家长密码">
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
            padding:"10px 14px",borderRadius:10,background:"#F8FAFC",border:"1.5px solid #E2E8F0"}}>
            <div style={{fontSize:13,color:"#475569"}}>
              {local.pin ? "已设置 ●●●●" : "未设置（建议设置）"}
            </div>
            <button onClick={()=>setChangingPin(true)}
              style={{padding:"6px 14px",borderRadius:8,border:"none",
                background:"linear-gradient(135deg,#6366F1,#8B5CF6)",color:"white",
                fontSize:12,fontWeight:700,cursor:"pointer"}}>
              {local.pin?"修改":"设置"}
            </button>
          </div>
        </Section>

        <button onClick={()=>onSave(local)}
          style={{width:"100%",padding:13,borderRadius:12,border:"none",
            background:"linear-gradient(135deg,#6366F1,#8B5CF6)",color:"white",
            fontSize:15,fontWeight:800,cursor:"pointer",marginTop:4}}>
          保存
        </button>

        <button onClick={()=>{ onSave(local); onShowReport(); }}
          style={{width:"100%",padding:12,borderRadius:12,marginTop:10,
            border:"1.5px solid #E2E8F0",background:"#F8FAFC",
            color:"#475569",fontSize:14,fontWeight:700,cursor:"pointer"}}>
          📊 查看使用报告
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{marginBottom:20}}>
      <div style={{fontSize:11,fontWeight:700,color:"#94a3b8",marginBottom:8,
        textTransform:"uppercase",letterSpacing:1}}>{title}</div>
      {children}
    </div>
  );
}

// ─── Report Panel ─────────────────────────────────────────────────────────────
function ReportPanel({ onClose, apiKey }) {
  const usage = load(STORAGE_KEYS.usage, {});
  const sessions = load(STORAGE_KEYS.sessions, []);
  const [tab, setTab] = useState("log"); // "log" | "analysis"
  const [expandedIdx, setExpandedIdx] = useState(null);
  const [range, setRange] = useState("week"); // "week" | "month" | "all"
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState("");
  const [analysisError, setAnalysisError] = useState("");

  const days = Object.keys(usage).sort().slice(-14);
  const totalTurns = days.reduce((s,d)=>s+(usage[d]?.turns||0),0);
  const totalSessions = days.reduce((s,d)=>s+(usage[d]?.sessions||0),0);
  const maxTurns = Math.max(...days.map(d=>usage[d]?.turns||0), 1);

  // 按时间范围筛选 sessions
  const filteredSessions = sessions.filter(s => {
    if (range === "all") return true;
    const now = new Date();
    const d = new Date(s.date);
    if (range === "week") {
      const cutoff = new Date(now); cutoff.setDate(now.getDate() - 7);
      return d >= cutoff;
    }
    if (range === "month") {
      const cutoff = new Date(now); cutoff.setDate(now.getDate() - 30);
      return d >= cutoff;
    }
    return true;
  }).slice().reverse();

  const generateAnalysis = async () => {
    if (!apiKey) { setAnalysisError("请先在设置里填入 API Key"); return; }
    setAnalyzing(true);
    setAnalysisResult("");
    setAnalysisError("");

    // 构造对话摘要文本
    const sessionTexts = filteredSessions.map((s, i) => {
      const msgs = (s.messages || [])
        .filter(m => m.role !== "assistant" || !m.content.startsWith("👋"))
        .map(m => {
          const text = typeof m.content === "string" ? m.content : m.content?.find?.(c=>c.type==="text")?.text ?? "[图片]";
          return `${m.role === "user" ? "孩子" : "小问"}：${text.slice(0, 200)}`;
        }).join("\n");
      return `【对话${i+1}】${s.date} ${s.needsHelp ? "（需要家长帮助）" : ""}\n题目：${s.name}\n${msgs}`;
    }).join("\n\n---\n\n");

    const prompt = `以下是一个10岁小学生使用AI学习伙伴"小问"的对话记录（${range === "week" ? "最近7天" : range === "month" ? "最近30天" : "全部记录"}，共${filteredSessions.length}次对话）：

${sessionTexts}

请从家长视角分析孩子的学习状况，输出以下内容：

1. **总体学习状态**（2-3句话）
2. **孩子擅长的方面**
3. **孩子卡住最多的题目类型**
4. **学习态度分析**（主动性、遇到困难的反应）
5. **给家长的建议**（具体、可操作）

语言简洁，像老师写给家长的反馈报告，不超过400字。`;

    try {
      const isNative = window.Capacitor?.isNativePlatform?.();
      let result;
      if (isNative) {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1000,
            messages: [{ role: "user", content: prompt }] })
        });
        result = await res.json();
      } else {
        const res = await fetch("http://localhost:3001/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey, messages: [{ role: "user", content: prompt }] })
        });
        result = await res.json();
      }
      setAnalysisResult(result.content?.[0]?.text || "分析失败，请重试");
    } catch(e) {
      setAnalysisError("生成失败：" + e.message);
    } finally {
      setAnalyzing(false);
    }
  };

  const TabBtn = ({ id, label }) => (
    <button onClick={() => setTab(id)}
      style={{flex:1, padding:"9px 0", borderRadius:10, border:"none", cursor:"pointer",
        fontWeight:700, fontSize:13, fontFamily:"'Nunito',sans-serif",
        background: tab === id ? "#6366F1" : "transparent",
        color: tab === id ? "white" : "#94a3b8", transition:"all .15s"}}>
      {label}
    </button>
  );

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,.5)",backdropFilter:"blur(4px)",
      zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:"white",borderRadius:20,padding:24,width:"100%",maxWidth:480,
        maxHeight:"90vh",overflowY:"auto",boxShadow:"0 20px 60px rgba(0,0,0,.2)"}}>

        {/* Header */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:18}}>
          <div style={{fontSize:17,fontWeight:800,color:"#1e293b"}}>📊 家长报告</div>
          <button onClick={onClose} style={{border:"none",background:"#F1F5F9",borderRadius:8,
            width:32,height:32,cursor:"pointer",fontSize:14,color:"#64748b"}}>✕</button>
        </div>

        {/* Summary cards */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:18}}>
          {[
            {label:"近14天对话轮次", value:totalTurns, icon:"💬"},
            {label:"近14天对话次数", value:totalSessions, icon:"📅"},
          ].map(c=>(
            <div key={c.label} style={{padding:"14px 16px",borderRadius:12,background:"#F8FAFC",
              border:"1.5px solid #E2E8F0"}}>
              <div style={{fontSize:20}}>{c.icon}</div>
              <div style={{fontSize:24,fontWeight:800,color:"#1e293b",marginTop:4}}>{c.value}</div>
              <div style={{fontSize:11,color:"#94a3b8",marginTop:2}}>{c.label}</div>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div style={{display:"flex",background:"#F1F5F9",borderRadius:12,padding:3,marginBottom:18,gap:3}}>
          <TabBtn id="log" label="📋 对话记录" />
          <TabBtn id="analysis" label="🧠 阶段分析" />
          <TabBtn id="memory" label="🌱 成长记录" />
        </div>

        {/* 对话记录 Tab */}
        {tab === "log" && (
          <div>
            {sessions.length === 0 && (
              <div style={{textAlign:"center",color:"#94a3b8",fontSize:13,padding:"30px 0"}}>暂无对话记录</div>
            )}
            {sessions.slice().reverse().map((s, i) => (
              <div key={i} style={{borderRadius:12,border:"1.5px solid #E2E8F0",
                marginBottom:8,overflow:"hidden"}}>
                {/* Session header */}
                <div onClick={() => setExpandedIdx(expandedIdx === i ? null : i)}
                  style={{padding:"11px 14px",cursor:"pointer",display:"flex",
                    alignItems:"center",justifyContent:"space-between",
                    background: expandedIdx === i ? "#F8FAFC" : "white"}}>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <div style={{fontSize:13,fontWeight:700,color:"#1e293b",
                        overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:200}}>
                        {s.name}
                      </div>
                      {s.needsHelp && (
                        <span style={{fontSize:10,background:"#FEF3C7",color:"#D97706",
                          padding:"2px 6px",borderRadius:6,fontWeight:700,flexShrink:0}}>需家长</span>
                      )}
                    </div>
                    <div style={{fontSize:11,color:"#94a3b8",marginTop:2}}>
                      {s.date} · {s.turns} 轮对话
                    </div>
                  </div>
                  <div style={{color:"#94a3b8",fontSize:12,marginLeft:8}}>
                    {expandedIdx === i ? "▲" : "▼"}
                  </div>
                </div>

                {/* Expanded messages */}
                {expandedIdx === i && (
                  <div style={{padding:"0 14px 14px",borderTop:"1px solid #E2E8F0",
                    maxHeight:320,overflowY:"auto",background:"#FAFBFC"}}>
                    {(s.messages || []).filter(m => m.role !== "assistant" || !m.content?.startsWith?.("👋")).map((m, j) => {
                      const text = typeof m.content === "string" ? m.content
                        : m.content?.find?.(c=>c.type==="text")?.text ?? "[图片]";
                      const isUser = m.role === "user";
                      return (
                        <div key={j} style={{marginTop:10,display:"flex",
                          justifyContent: isUser ? "flex-end" : "flex-start"}}>
                          <div style={{maxWidth:"85%",padding:"8px 12px",borderRadius:12,
                            fontSize:12,lineHeight:1.55,wordBreak:"break-word",
                            background: isUser ? "linear-gradient(135deg,#6366F1,#8B5CF6)" : "white",
                            color: isUser ? "white" : "#1e293b",
                            boxShadow:"0 1px 4px rgba(0,0,0,.08)"}}>
                            {text}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* 阶段分析 Tab */}
        {tab === "analysis" && (
          <div>
            {/* Bar chart */}
            <div style={{marginBottom:18}}>
              <div style={{fontSize:12,fontWeight:700,color:"#64748b",marginBottom:10}}>每日对话轮次（近14天）</div>
              <div style={{display:"flex",alignItems:"flex-end",gap:4,height:72}}>
                {days.length === 0
                  ? <div style={{color:"#94a3b8",fontSize:13,padding:"10px 0"}}>暂无数据</div>
                  : days.map(d=>{
                    const t = usage[d]?.turns||0;
                    const h = Math.max((t/maxTurns)*64, t>0?6:2);
                    return (
                      <div key={d} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:3}}>
                        <div style={{width:"100%",height:h,borderRadius:"4px 4px 0 0",
                          background:t>0?"linear-gradient(180deg,#818CF8,#6366F1)":"#E2E8F0",transition:"height .3s"}}
                          title={`${d}: ${t}轮`} />
                        <div style={{fontSize:9,color:"#94a3b8"}}>{d.slice(5)}</div>
                      </div>
                    );
                  })}
              </div>
            </div>

            {/* Range selector */}
            <div style={{fontSize:12,fontWeight:700,color:"#64748b",marginBottom:8}}>分析时间范围</div>
            <div style={{display:"flex",gap:8,marginBottom:16}}>
              {[{id:"week",label:"最近7天"},{id:"month",label:"最近30天"},{id:"all",label:"全部记录"}].map(r=>(
                <button key={r.id} onClick={()=>{ setRange(r.id); setAnalysisResult(""); }}
                  style={{flex:1,padding:"8px 0",borderRadius:10,cursor:"pointer",
                    fontWeight:700,fontSize:12,fontFamily:"'Nunito',sans-serif",
                    border:`1.5px solid ${range===r.id?"#6366F1":"#E2E8F0"}`,
                    background:range===r.id?"#EEF2FF":"white",
                    color:range===r.id?"#6366F1":"#94a3b8"}}>
                  {r.label}
                </button>
              ))}
            </div>

            <div style={{fontSize:12,color:"#94a3b8",marginBottom:12}}>
              该时段共 {filteredSessions.length} 次对话，
              其中 {filteredSessions.filter(s=>s.needsHelp).length} 次需要家长帮助
            </div>

            {/* Generate button */}
            <button onClick={generateAnalysis} disabled={analyzing || filteredSessions.length === 0}
              style={{width:"100%",padding:12,borderRadius:12,border:"none",
                background: filteredSessions.length === 0 ? "#E2E8F0" : "linear-gradient(135deg,#6366F1,#8B5CF6)",
                color: filteredSessions.length === 0 ? "#94a3b8" : "white",
                fontSize:14,fontWeight:700,cursor: filteredSessions.length === 0 ? "default" : "pointer",
                fontFamily:"'Nunito',sans-serif",marginBottom:14}}>
              {analyzing ? "分析中…" : "🧠 生成学习分析报告"}
            </button>

            {analysisError && (
              <div style={{padding:"10px 14px",borderRadius:10,background:"#FEF2F2",
                color:"#EF4444",fontSize:13,marginBottom:12}}>
                {analysisError}
              </div>
            )}

            {analysisResult && (
              <div style={{padding:"16px",borderRadius:12,background:"#F8FAFC",
                border:"1.5px solid #E2E8F0",fontSize:13,lineHeight:1.8,
                color:"#1e293b",whiteSpace:"pre-wrap"}}>
                {analysisResult}
              </div>
            )}
          </div>
        )}

        {/* 成长记录 Tab */}
        {tab === "memory" && <MemoryTimeline />}

      </div>
    </div>
  );
}

// ─── Memory Timeline ──────────────────────────────────────────────────────────
function MemoryTimeline() {
  const memories = loadMemories().slice().reverse();
  if (memories.length === 0) {
    return (
      <div style={{textAlign:"center",color:"#94a3b8",fontSize:14,padding:"40px 20px",lineHeight:2}}>
        还没有记录。<br/>
        孩子多和小问聊几次之后，<br/>
        这里会自动出现他的成长轨迹。
      </div>
    );
  }
  const grouped = {};
  for (const m of memories) {
    if (!grouped[m.date]) grouped[m.date] = [];
    grouped[m.date].push(m);
  }
  return (
    <div>
      <div style={{fontSize:12,color:"#94a3b8",marginBottom:16,lineHeight:1.6}}>
        共 {memories.length} 条记录 · 由AI自动生成，孩子不可见
      </div>
      {Object.keys(grouped).sort().reverse().map(date => (
        <div key={date} style={{marginBottom:20}}>
          <div style={{fontSize:11,fontWeight:700,color:"#94a3b8",marginBottom:8,letterSpacing:1}}>{date}</div>
          {grouped[date].map((m,i) => (
            <div key={i} style={{padding:"12px 14px",borderRadius:10,background:"#F8FAFC",
              border:"1px solid #E2E8F0",fontSize:13,color:"#334155",lineHeight:1.7,marginBottom:8}}>
              {m.summary}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}


// ─── Message ──────────────────────────────────────────────────────────────────
function Message({ msg, owl }) {
  const isUser = msg.role === "user";
  const displayText = msg._displayText ?? (typeof msg.content === "string" ? msg.content : msg.content?.find?.(c=>c.type==="text")?.text ?? "");
  const previewImage = msg._previewImage;

  return (
    <div style={{display:"flex",justifyContent:isUser?"flex-end":"flex-start",
      marginBottom:14,alignItems:"flex-end",gap:8}}>
      {!isUser && (
        <div style={{width:36,height:36,borderRadius:"50%",
          background:"linear-gradient(135deg,#6EE7B7,#3B82F6)",
          display:"flex",alignItems:"center",justifyContent:"center",
          fontSize:18,flexShrink:0}}>
          {owl}
        </div>
      )}
      <div style={{maxWidth:"74%",display:"flex",flexDirection:"column",gap:6,
        alignItems:isUser?"flex-end":"flex-start"}}>
        {previewImage && (
          <img src={previewImage} alt="题目图片"
            style={{maxWidth:"100%",maxHeight:200,borderRadius:12,
              boxShadow:"0 2px 12px rgba(0,0,0,.12)",objectFit:"contain",
              border:"2px solid rgba(99,102,241,.2)"}} />
        )}
        {displayText && (
          <div style={{padding:"11px 15px",
            borderRadius:isUser?"18px 18px 4px 18px":"18px 18px 18px 4px",
            background:isUser?"linear-gradient(135deg,#6366F1,#8B5CF6)":"white",
            color:isUser?"white":"#1e293b",fontSize:15,lineHeight:1.65,
            boxShadow:isUser?"0 2px 12px rgba(99,102,241,.3)":"0 2px 12px rgba(0,0,0,.08)",
            whiteSpace:"pre-wrap",wordBreak:"break-word"}}>
            <MathText text={displayText} />
          </div>
        )}
        {!displayText && previewImage && isUser && (
          <div style={{padding:"8px 14px",borderRadius:"18px 18px 4px 18px",
            background:"linear-gradient(135deg,#6366F1,#8B5CF6)",
            color:"white",fontSize:13,
            boxShadow:"0 2px 12px rgba(99,102,241,.3)"}}>
            📷 题目图片
          </div>
        )}
      </div>
      {isUser && (
        <div style={{width:36,height:36,borderRadius:"50%",
          background:"linear-gradient(135deg,#F59E0B,#EF4444)",
          display:"flex",alignItems:"center",justifyContent:"center",
          fontSize:18,flexShrink:0}}>
          🧒
        </div>
      )}
    </div>
  );
}

function TypingIndicator({ owl }) {
  return (
    <div style={{display:"flex",alignItems:"flex-end",gap:8,marginBottom:14}}>
      <div style={{width:36,height:36,borderRadius:"50%",
        background:"linear-gradient(135deg,#6EE7B7,#3B82F6)",
        display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>
        {owl}
      </div>
      <div style={{padding:"12px 16px",borderRadius:"18px 18px 18px 4px",
        background:"white",boxShadow:"0 2px 12px rgba(0,0,0,.08)",
        display:"flex",gap:5,alignItems:"center"}}>
        {[0,1,2].map(i=>(
          <div key={i} style={{width:8,height:8,borderRadius:"50%",background:"#94a3b8",
            animation:"bounce 1.2s infinite",animationDelay:`${i*0.2}s`}} />
        ))}
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
const WELCOME_MSG = (owl) => ({
  role:"assistant",
  content:`嗨！我是小问 ${owl} 有什么不懂的题目，或者想聊的知识，都可以问我！\n\n我不会直接告诉你答案哦——我会帮你一步一步自己想出来 😄`,
});

export default function XiaowApp() {
  const [settings, setSettings] = useState(() => load(STORAGE_KEYS.settings, DEFAULT_SETTINGS));
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [pendingImage, setPendingImage] = useState(null); // { base64, mediaType, previewUrl }

  // UI panels
  const [showSettings, setShowSettings] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [showCustomize, setShowCustomize] = useState(false);
  const [pinModal, setPinModal] = useState(null); // {action, callback}

  // Session tracking
  const sessionStarted = useRef(false);
  const sessionTurns = useRef(0);
  const [showParentHelp, setShowParentHelp] = useState(false);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);

  const owl = settings.owl || "🦉";
  const bgTheme = BG_THEMES.find(t=>t.id===settings.bgTheme) || BG_THEMES[0];
  const hasKey = !!settings.apiKey;

  // Init welcome message
  useEffect(() => {
    setMessages([WELCOME_MSG(owl)]);
  }, [owl]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior:"smooth" });
  }, [messages, loading]);

  // Save settings whenever they change
  useEffect(() => {
    save(STORAGE_KEYS.settings, settings);
  }, [settings]);

  const requirePin = (action, callback) => {
    if (!settings.pin) { callback(); return; }
    setPinModal({ action, callback });
  };

  const handleSaveSettings = (newSettings) => {
    setSettings(newSettings);
    setShowSettings(false);
  };

  const handleImageSelect = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const base64 = ev.target.result.split(",")[1];
      const mediaType = file.type || "image/jpeg";
      const previewUrl = ev.target.result;
      setPendingImage({ base64, mediaType, previewUrl });
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const sendMessage = async () => {
    const text = input.trim();
    if ((!text && !pendingImage) || loading || !hasKey) return;
    setError("");

    // Track session start
    if (!sessionStarted.current) {
      sessionStarted.current = true;
      recordSession();
    }

    // 构造用户消息，支持图片
    const userContent = [];
    if (pendingImage) {
      userContent.push({
        type: "image",
        source: { type: "base64", media_type: pendingImage.mediaType, data: pendingImage.base64 }
      });
    }
    if (text) {
      userContent.push({ type: "text", text });
    }

    const userMsg = {
      role: "user",
      content: userContent.length === 1 && userContent[0].type === "text"
        ? text  // 纯文字保持字符串格式（兼容历史消息）
        : userContent,
      // 保存预览用
      _previewImage: pendingImage?.previewUrl,
      _displayText: text,
    };

    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput("");
    setPendingImage(null);
    setLoading(true);

    // 构造发给 API 的消息（去掉 _preview 字段）
    const apiMessages = newMessages.map(m => ({ role: m.role, content: m.content }));

    try {
      // 先插入空占位消息
      setMessages([...newMessages, { role:"assistant", content:"" }]);

      const fullText = await callClaude(settings.apiKey, apiMessages, (partial) => {
        const display = partial.startsWith("[新题目]") ? partial.slice(5).trimStart() : partial;
        setMessages([...newMessages, { role:"assistant", content: display.replace("[需要帮助]","").trimEnd() }]);
      }, getSystemPrompt(settings.level) + buildMemoryContext() + getQiyueContext() + SHARED_RULES);

      // 检测标记
      if (fullText.startsWith("[新题目]")) {
        setShowParentHelp(false); // 新题目重置提示
      }
      if (fullText.includes("[需要帮助]")) {
        setShowParentHelp(true);
      }

      const cleanText = fullText
        .replace(/^\[新题目\]\s*/,"")
        .replace(/\[需要帮助\]/g,"")
        .trimEnd();

      const assistantMsg = { role:"assistant", content: cleanText || "抱歉，没有收到回复，请再试一次。" };
      const finalMessages = [...newMessages, assistantMsg];
      setMessages(finalMessages);

      // Record usage
      sessionTurns.current += 1;
      recordUsage(1);

      // Save session snapshot
      const allSessions = load(STORAGE_KEYS.sessions, []);
      const today = todayKey();
      const lastIdx = allSessions.length - 1;
      const firstUserMsg = finalMessages.find(m=>m.role==="user");
      const sessionName = firstUserMsg?.content.slice(0,24) || "对话";

      if (allSessions[lastIdx]?.date === today && sessionStarted.current) {
        allSessions[lastIdx] = { ...allSessions[lastIdx], turns: sessionTurns.current, messages: finalMessages, needsHelp: allSessions[lastIdx].needsHelp || fullText.includes("[需要帮助]") };
      } else {
        allSessions.push({ date: today, name: sessionName, turns: sessionTurns.current, messages: finalMessages, needsHelp: fullText.includes("[需要帮助]") });
      }
      save(STORAGE_KEYS.sessions, allSessions.slice(-200));

      // 静默生成记忆摘要（不阻塞UI）
      generateMemorySummary(settings.apiKey, finalMessages).catch(()=>{});

    } catch(e) {
      setError(`请求失败：${e.message}`);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  const handleKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  const clearChat = () => {
    sessionStarted.current = false;
    sessionTurns.current = 0;
    setShowParentHelp(false);
    setMessages([WELCOME_MSG(owl)]);
    setError("");
  };

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&display=swap');
        * { box-sizing:border-box; margin:0; padding:0; }
        body { font-family:'Nunito',sans-serif; }
        @keyframes bounce { 0%,60%,100%{transform:translateY(0)} 30%{transform:translateY(-6px)} }
        @keyframes fadeIn { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
        @keyframes popIn { from{opacity:0;transform:scale(.9)} to{opacity:1;transform:scale(1)} }
        textarea:focus { outline:none; }
        textarea { font-family:'Nunito',sans-serif; }
        ::-webkit-scrollbar { width:4px; }
        ::-webkit-scrollbar-thumb { background:#e2e8f0; border-radius:4px; }
        input:focus { outline:none; }
        :root {
          --sat: env(safe-area-inset-top, 0px);
          --sab: env(safe-area-inset-bottom, 0px);
        }
      `}</style>

      {/* PIN modal */}
      {pinModal && (
        <PinModal mode="verify" savedPin={settings.pin}
          onSuccess={() => { pinModal.callback(); setPinModal(null); }}
          onClose={() => setPinModal(null)} />
      )}

      {/* Settings */}
      {showSettings && (
        <SettingsPanel settings={settings} onSave={handleSaveSettings}
          onClose={() => setShowSettings(false)}
          onShowReport={() => { setShowSettings(false); setShowReport(true); }} />
      )}

      {/* Report */}
      {showReport && (
        <ReportPanel onClose={() => setShowReport(false)} apiKey={settings.apiKey} />
      )}

      {/* 孩子自定义面板 */}
      {showCustomize && (
        <div style={{position:"fixed",inset:0,zIndex:150,display:"flex",flexDirection:"column",justifyContent:"flex-end"}}
          onClick={()=>setShowCustomize(false)}>
          <div onClick={e=>e.stopPropagation()}
            style={{background:"white",borderRadius:"20px 20px 0 0",padding:"20px 20px 32px",
              boxShadow:"0 -8px 40px rgba(0,0,0,.15)"}}>
            <div style={{width:36,height:4,borderRadius:2,background:"#E2E8F0",margin:"0 auto 20px"}} />
            <div style={{fontSize:13,fontWeight:800,color:"#94a3b8",marginBottom:14,
              textTransform:"uppercase",letterSpacing:1}}>选一个形象</div>
            <div style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:22}}>
              {OWL_OPTIONS.map(o=>(
                <button key={o} onClick={()=>{
                  setSettings(s=>({...s, owl:o}));
                }}
                  style={{width:52,height:52,borderRadius:14,
                    border:`3px solid ${settings.owl===o?"#6366F1":"#E2E8F0"}`,
                    background:settings.owl===o?"#EEF2FF":"#F8FAFC",
                    fontSize:26,cursor:"pointer",transition:"all .15s",
                    boxShadow:settings.owl===o?"0 2px 8px rgba(99,102,241,.3)":"none"}}>
                  {o}
                </button>
              ))}
            </div>
            <div style={{fontSize:13,fontWeight:800,color:"#94a3b8",marginBottom:14,
              textTransform:"uppercase",letterSpacing:1}}>选一个背景</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              {BG_THEMES.map(t=>(
                <button key={t.id} onClick={()=>setSettings(s=>({...s, bgTheme:t.id}))}
                  style={{flex:"1 0 calc(33% - 8px)",padding:"12px 6px",borderRadius:12,
                    border:`3px solid ${settings.bgTheme===t.id?"#6366F1":"transparent"}`,
                    background:t.value,cursor:"pointer",fontSize:13,fontWeight:800,
                    color:"#475569",minWidth:80,
                    boxShadow:settings.bgTheme===t.id?"0 2px 8px rgba(99,102,241,.3)":"0 1px 4px rgba(0,0,0,.08)"}}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <div style={{height:"100vh",display:"flex",flexDirection:"column",
        background:bgTheme.value,fontFamily:"'Nunito',sans-serif",transition:"background .4s"}}>

        {/* Header */}
        <div style={{padding:"13px 16px",paddingTop:"calc(13px + var(--sat))",background:"rgba(255,255,255,.85)",
          backdropFilter:"blur(12px)",boxShadow:"0 1px 0 rgba(0,0,0,.06)",
          display:"flex",alignItems:"center",gap:12}}>

          <div onClick={()=>setShowCustomize(v=>!v)}
            style={{width:44,height:44,borderRadius:"50%",
            background:"linear-gradient(135deg,#6EE7B7,#3B82F6)",
            display:"flex",alignItems:"center",justifyContent:"center",
            fontSize:22,boxShadow:"0 2px 8px rgba(59,130,246,.3)",
            animation:"popIn .4s ease",flexShrink:0,cursor:"pointer",
            transition:"transform .15s",transform:showCustomize?"scale(1.1)":"scale(1)"}}>
            {owl}
          </div>

          <div>
            <div style={{fontWeight:900,fontSize:17,color:"#1e293b"}}>小问</div>
            <div style={{fontSize:11,color:"#64748b",fontWeight:600}}>引导你自己找到答案</div>
          </div>

          <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:6}}>
            {messages.length > 1 && (
              <button onClick={clearChat}
                style={{padding:"5px 10px",borderRadius:8,border:"1px solid #E2E8F0",
                  background:"transparent",color:"#94a3b8",fontSize:12,cursor:"pointer",fontWeight:600}}>
                换题
              </button>
            )}
            <button onClick={() => requirePin("settings", () => setShowSettings(true))}
              style={{width:34,height:34,borderRadius:10,border:"1px solid #E2E8F0",
                background:"rgba(255,255,255,.8)",cursor:"pointer",fontSize:16,
                display:"flex",alignItems:"center",justifyContent:"center"}}>
              ⚙️
            </button>
          </div>
        </div>

        {/* No key warning */}
        {!hasKey && (
          <div style={{background:"#FFF7ED",borderBottom:"1px solid #FED7AA",
            padding:"9px 16px",textAlign:"center",fontSize:13,color:"#EA580C",fontWeight:700}}>
            请家长点击右上角 ⚙️ 填入 API Key
          </div>
        )}

        {/* Messages */}
        <div style={{flex:1,overflowY:"auto",padding:"18px 16px"}}>
          <div style={{maxWidth:680,width:"100%",margin:"0 auto"}}>
            {messages.map((msg,i) => (
              <div key={i} style={{animation:"fadeIn .3s ease"}}>
                <Message msg={msg} owl={owl} />
              </div>
            ))}
            {loading && messages[messages.length-1]?.content === "" && <TypingIndicator owl={owl} />}

            {/* AI判断孩子需要家长帮助时显示 */}
            {showParentHelp && !loading && (
              <div style={{margin:"8px 0 14px",padding:"12px 16px",borderRadius:14,
                background:"linear-gradient(135deg,#FFF7ED,#FEF3C7)",
                border:"1.5px solid #FED7AA",display:"flex",alignItems:"center",gap:10,
                animation:"fadeIn .4s ease"}}>
                <div style={{fontSize:22,flexShrink:0}}>💡</div>
                <div style={{fontSize:13,color:"#92400E",lineHeight:1.5}}>
                  <span style={{fontWeight:800}}>这道题有点难哦！</span><br/>
                  如果还是想不出来，可以请爸爸妈妈一起看看 😊
                </div>
              </div>
            )}
            {error && (
              <div style={{textAlign:"center",fontSize:12,color:"#EF4444",
                padding:"8px 16px",background:"#FEF2F2",borderRadius:8,marginBottom:12,
                border:"1px solid #FECACA"}}>
                {error}
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        {/* Input */}
        <div style={{padding:"12px 16px",paddingBottom:"calc(20px + var(--sab))",background:"rgba(255,255,255,.85)",
          backdropFilter:"blur(12px)",boxShadow:"0 -1px 0 rgba(0,0,0,.06)"}}>

          {/* 图片预览 */}
          {pendingImage && (
            <div style={{maxWidth:680,margin:"0 auto 10px",position:"relative",display:"inline-block"}}>
              <img src={pendingImage.previewUrl} alt="待发送图片"
                style={{maxHeight:120,maxWidth:"100%",borderRadius:10,
                  border:"2px solid #6366F1",objectFit:"contain",display:"block"}} />
              <button onClick={()=>setPendingImage(null)}
                style={{position:"absolute",top:-8,right:-8,width:22,height:22,
                  borderRadius:"50%",border:"none",background:"#EF4444",color:"white",
                  fontSize:12,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",
                  fontWeight:700,lineHeight:1}}>✕</button>
            </div>
          )}

          <div style={{maxWidth:680,margin:"0 auto",display:"flex",gap:10,alignItems:"flex-end",
            background:"white",border:"2px solid #E2E8F0",borderRadius:16,
            padding:"10px 10px 10px 12px",boxShadow:"0 2px 8px rgba(0,0,0,.04)"}}>

            {/* 拍照按钮 */}
            <input ref={fileInputRef} type="file" accept="image/*" capture="environment"
              onChange={handleImageSelect}
              style={{display:"none"}} />
            <button onClick={()=>fileInputRef.current?.click()} disabled={!hasKey||loading}
              title="拍照上传题目"
              style={{width:36,height:36,borderRadius:9,border:"1.5px solid #E2E8F0",
                background:pendingImage?"#EEF2FF":"#F8FAFC",cursor:hasKey?"pointer":"not-allowed",
                fontSize:18,display:"flex",alignItems:"center",justifyContent:"center",
                flexShrink:0,color:pendingImage?"#6366F1":"#94a3b8",transition:"all .2s"}}>
              📷
            </button>

            <textarea ref={inputRef} value={input}
              onChange={e=>setInput(e.target.value)} onKeyDown={handleKey}
              placeholder={hasKey ? (pendingImage ? "可以补充文字说明（选填）……" : "把你的问题告诉我……") : "请家长先设置 API Key"}
              disabled={!hasKey} rows={1}
              style={{flex:1,border:"none",background:"transparent",fontSize:15,
                color:"#1e293b",resize:"none",lineHeight:1.5,maxHeight:120,overflowY:"auto"}}
              onInput={e=>{ e.target.style.height="auto"; e.target.style.height=Math.min(e.target.scrollHeight,120)+"px"; }} />
            <button onClick={sendMessage} disabled={(!input.trim()&&!pendingImage)||loading||!hasKey}
              style={{width:40,height:40,borderRadius:11,border:"none",
                background:(input.trim()||pendingImage)&&!loading&&hasKey
                  ?"linear-gradient(135deg,#6366F1,#8B5CF6)":"#E2E8F0",
                color:(input.trim()||pendingImage)&&!loading&&hasKey?"white":"#94A3B8",
                fontSize:18,cursor:(input.trim()||pendingImage)&&!loading&&hasKey?"pointer":"not-allowed",
                display:"flex",alignItems:"center",justifyContent:"center",
                flexShrink:0,transition:"all .2s"}}>
              ➤
            </button>
          </div>
          <div style={{maxWidth:680,margin:"7px auto 0",textAlign:"center",
            fontSize:11,color:"#94a3b8",fontWeight:600}}>
            Enter 发送 · Shift+Enter 换行 · 📷 拍照上传题目
          </div>
        </div>
      </div>
    </>
  );
}
