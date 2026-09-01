// 展示案例種子腳本：「【模擬】國防軍購特別預算公投」
//
// 以第 11 屆立法院的政黨席次結構（綠 51、藍 52、白 8、無黨籍 2）建立 113 位
// **虛構**模擬參與者。化名取自台灣物種與地景，非真實姓名；投票由「黨團基準
// 機率 + 個人隨機偏移」的模型產生，不代表任何真實個人或黨團的立場。
//
//   node scripts/seed-demo-legislature.mjs [base-url]
//
// 預設打 https://polis.tw。輸出參與/結果/管理連結（管理金鑰只印在
// 終端，不落地）。同一個 SEED 重跑會產生同樣的投票模式（但會建立新對話）。

const args = process.argv.slice(2).filter((a) => a !== "--lang" && a !== "en");
const LANG = process.argv.includes("en") && process.argv.includes("--lang") ? "en" : "zh";
const BASE = args[0] ?? "https://polis.tw";
const SEED = 20260901;

// ---- 決定性 PRNG ----
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);

// ---- 虛構化名（台灣物種與地景，非真實人名） ----
const CODENAMES = [
  "石虎", "黑面琵鷺", "藍鵲", "帝雉", "山椒魚", "櫻花鉤吻鮭", "食蛇龜", "穿山甲",
  "水獺", "白海豚", "灰面鵟鷹", "八色鳥", "領角鴞", "大冠鷲", "五色鳥", "紫斑蝶",
  "寬尾鳳蝶", "翡翠樹蛙", "諸羅樹蛙", "梅花鹿", "白鼻心", "飛鼠", "山羌", "野山羊",
  "玉山", "雪山", "大霸尖山", "合歡山", "奇萊", "南湖大山", "北大武", "都蘭山",
  "濁水溪", "曾文溪", "秀姑巒溪", "蘭陽溪", "淡水河", "高屏溪", "卑南溪", "大甲溪",
  "黑潮", "落山風", "九降風", "油桐", "苦楝", "茄苳", "樟樹", "紅檜",
];

// ---- 樣本：第 11 屆立院席次結構（2024–）----
const BLOCS = [
  { key: "green", label: "綠（民進黨團）", seats: 51 },
  { key: "blue", label: "藍（國民黨團）", seats: 52 },
  { key: "white", label: "白（民眾黨團）", seats: 8 },
  { key: "ind", label: "無黨籍", seats: 2 },
];

// ---- 英文版種子意見（與中文版一一對應，供 --lang en 使用） ----
const STATEMENTS_EN = [
  "China's military pressure on Taiwan is rising fast; Taiwan must visibly strengthen deterrence within a decade.",
  "Funding large-scale arms procurement through a special (debt-financed) budget is an acceptable fiscal arrangement.",
  "Procurement should prioritize proven, off-the-shelf US equipment to shorten the time to combat readiness.",
  "Rather than importing at scale, more budget should go to domestically built weapons and the local defense industry.",
  "Asymmetric capabilities (mobile missiles, drones, sea mines) deserve priority over large platforms (fighter jets, large warships).",
  "A major defense expansion would crowd out social welfare, long-term care, and education spending beyond what society can bear.",
  "Taiwan's defense budget should reach at least 3% of GDP before 2030.",
  "Too much of major procurement sits in classified budgets; the legislature's real oversight is insufficient.",
  "An independent audit and cost-effectiveness review should be established, publishing an unclassified report for every case.",
  "Improving pay and training for volunteer forces and reservists is more urgent than buying new equipment.",
  "Whole-of-society resilience (civil defense training, critical infrastructure protection, strategic stockpiles) should be funded alongside procurement.",
  "Restoring institutionalized cross-strait dialogue would reduce the risk of war more than buying more arms.",
  "More procurement will fuel an arms race and actually make the Taiwan Strait less safe.",
  "Pricing and delivery delays in US arms sales are serious; stronger negotiation and compensation mechanisms are needed.",
  "Highly specialized issues like national defense are not suitable for referendums.",
  "Given chronic delivery delays, the budget should first improve the readiness of existing equipment and ammunition stockpiles.",
  "The special budget should be reviewed in phases, with each tranche released based on execution performance.",
  "Procurement is a necessary investment in US-Taiwan trust; Taiwan's security ultimately depends on US commitments.",
  "Social resilience and economic strength, more than military hardware, are the real foundation of Taiwan's security.",
  "Wartime stockpiles of ammunition, energy, and food should take priority over new large platforms.",
  "The government should publish the concrete procurement list and priorities before the special budget goes to review.",
  "The results of conscription and reservist reform should be part of evaluating overall defense investment.",
  "Technology transfer and industrial cooperation clauses should be a required condition of every foreign arms purchase.",
  "Opposition parties cutting or freezing the defense budget in the legislature is irresponsible.",
];

const META = {
  zh: {
    title: "【模擬】國防軍購特別預算公投",
    description:
      "這是 Pocket Polis（口袋審議）的展示案例（全部虛構）。情境：政府擬以特別條例編列約 1.25 兆元國防特別預算（2027–2033）大幅擴增軍購，本對話模擬公投前的社會討論。已有 113 位「虛構立法委員」依政黨席次結構（綠 51、藍 52、白 8、無黨籍 2）由程式模擬投票——化名取自台灣物種與地景，非真實個人，不代表任何真實立委或黨團立場。歡迎你直接加入投票、提出意見，看看意見地圖怎麼變化。",
  },
  en: {
    title: "[Simulation] Defense Procurement Special-Budget Referendum",
    description:
      "A Pocket Polis demo case — entirely fictional. Scenario: the government proposes a special act with roughly NT$1.25 trillion in defense procurement spending (2027–2033), and this conversation simulates the public debate before a referendum. 113 fictional legislators, matching Taiwan's actual party-seat structure (51 green, 52 blue, 8 white, 2 independents), have been simulated programmatically — pseudonyms come from Taiwanese wildlife and landscapes, represent no real person, and reflect no real legislator's or party's position. Join the voting and add statements to watch the opinion map change.",
  },
};

// ---- 陳述與各黨團基準機率 [同意, 略過, 不同意] ----
// 「ind」未列者沿用 blue 並提高略過率。機率為模型設定，非真實民調。
const STATEMENTS = [
  ["中國對台軍事壓力正在快速升高，台灣必須在十年內明顯提升嚇阻能力。",
    { green: [0.92, 0.05, 0.03], blue: [0.55, 0.2, 0.25], white: [0.75, 0.15, 0.1] }],
  ["以特別預算（舉債）方式支應大規模軍購，是可以接受的財政安排。",
    { green: [0.85, 0.08, 0.07], blue: [0.1, 0.1, 0.8], white: [0.2, 0.2, 0.6] }],
  ["軍購應優先向美國採購成熟現貨裝備，縮短戰力形成時間。",
    { green: [0.8, 0.1, 0.1], blue: [0.25, 0.2, 0.55], white: [0.4, 0.3, 0.3] }],
  ["與其大量外購，應把更多預算投入國造武器與本土國防產業。",
    { green: [0.55, 0.2, 0.25], blue: [0.75, 0.1, 0.15], white: [0.7, 0.15, 0.15] }],
  ["不對稱作戰能力（機動飛彈、無人機、水雷）比大型載台（戰機、大型軍艦）更值得優先投資。",
    { green: [0.8, 0.12, 0.08], blue: [0.4, 0.25, 0.35], white: [0.7, 0.15, 0.15] }],
  ["國防預算大幅擴張，會排擠社福、長照與教育支出，社會無法承受。",
    { green: [0.08, 0.12, 0.8], blue: [0.8, 0.1, 0.1], white: [0.45, 0.25, 0.3] }],
  ["台灣的國防預算占 GDP 比例，應在 2030 年前達到 3% 以上。",
    { green: [0.88, 0.07, 0.05], blue: [0.3, 0.25, 0.45], white: [0.5, 0.25, 0.25] }],
  ["重大軍購案的機密預算比例過高，立法院的實質監督不足。",
    { green: [0.2, 0.2, 0.6], blue: [0.85, 0.08, 0.07], white: [0.92, 0.05, 0.03] }],
  ["應設立獨立的軍購審計與成本效益評估機制，逐案公開非機密版本報告。",
    { green: [0.7, 0.18, 0.12], blue: [0.88, 0.07, 0.05], white: [0.95, 0.03, 0.02] }],
  ["提高志願役與後備軍人的待遇與訓練品質，比購買新裝備更迫切。",
    { green: [0.5, 0.2, 0.3], blue: [0.82, 0.1, 0.08], white: [0.75, 0.15, 0.1] }],
  ["全民防衛韌性（民防訓練、關鍵基礎設施防護、戰備儲糧）應與軍購同步投資。",
    { green: [0.9, 0.06, 0.04], blue: [0.75, 0.15, 0.1], white: [0.88, 0.08, 0.04] }],
  ["兩岸恢復制度化對話，比增加軍購更能降低戰爭風險。",
    { green: [0.06, 0.1, 0.84], blue: [0.88, 0.06, 0.06], white: [0.45, 0.3, 0.25] }],
  ["增加軍購會刺激軍備競賽，反而讓台海更不安全。",
    { green: [0.05, 0.08, 0.87], blue: [0.6, 0.2, 0.2], white: [0.25, 0.3, 0.45] }],
  ["美國對台軍售的價格與交付延宕問題嚴重，應建立更強的談判與求償機制。",
    { green: [0.35, 0.3, 0.35], blue: [0.85, 0.08, 0.07], white: [0.8, 0.12, 0.08] }],
  ["國防這類高度專業的議題，不適合用公民投票決定。",
    { green: [0.65, 0.2, 0.15], blue: [0.15, 0.15, 0.7], white: [0.4, 0.3, 0.3] }],
  ["新裝備交付動輒延宕多年，應先把預算用於提升現有裝備妥善率與彈藥儲備。",
    { green: [0.45, 0.25, 0.3], blue: [0.75, 0.12, 0.13], white: [0.7, 0.18, 0.12] }],
  ["軍購特別預算應分期審查，每一期依執行績效決定是否續撥。",
    { green: [0.45, 0.25, 0.3], blue: [0.82, 0.1, 0.08], white: [0.92, 0.05, 0.03] }],
  ["軍購是維繫台美互信的必要投資，台灣安全終究離不開美國的協防承諾。",
    { green: [0.82, 0.1, 0.08], blue: [0.35, 0.25, 0.4], white: [0.4, 0.35, 0.25] }],
  ["比起軍事硬體，社會韌性與經濟實力才是台灣安全的根本。",
    { green: [0.35, 0.25, 0.4], blue: [0.78, 0.12, 0.1], white: [0.65, 0.2, 0.15] }],
  ["彈藥、能源與糧食的戰備儲量，應優先於採購新的大型載台。",
    { green: [0.65, 0.2, 0.15], blue: [0.55, 0.25, 0.2], white: [0.72, 0.18, 0.1] }],
  ["政府應先公開特別預算的具體採購清單與優先順序，再交付立法院審查。",
    { green: [0.55, 0.25, 0.2], blue: [0.9, 0.06, 0.04], white: [0.95, 0.03, 0.02] }],
  ["役期與教召制度改革的成效，應納入整體國防投資的評估。",
    { green: [0.75, 0.15, 0.1], blue: [0.7, 0.18, 0.12], white: [0.85, 0.1, 0.05] }],
  ["技術移轉與產業合作條款，應是每一筆對外軍購的必要條件。",
    { green: [0.68, 0.2, 0.12], blue: [0.78, 0.12, 0.1], white: [0.85, 0.1, 0.05] }],
  ["在野黨在立法院刪減或凍結國防預算，是不負責任的做法。",
    { green: [0.85, 0.1, 0.05], blue: [0.06, 0.09, 0.85], white: [0.15, 0.25, 0.6] }],
];

// ---- 模擬參與者 ----
function buildLegislators() {
  const names = [];
  for (let round = 0; names.length < 120; round++) {
    for (const base of CODENAMES) names.push(round === 0 ? base : `${base}${round + 1}`);
  }
  let cursor = 0;
  const legislators = [];
  for (const bloc of BLOCS) {
    for (let i = 0; i < bloc.seats; i++) {
      legislators.push({
        codename: names[cursor++],
        bloc: bloc.key,
        blocLabel: bloc.label,
        // 個人偏移：把同意/不同意的機率質量挪動 ±0.15，模擬黨內光譜
        offset: (rng() - 0.5) * 0.3,
        pid: null, // 建立時填入
      });
    }
  }
  return legislators;
}

function sampleVote(probs, offset) {
  const [baseA, baseP, baseD] = probs;
  // offset > 0：把機率質量從「同意」搬到「不同意」；offset < 0 反向
  const pA = Math.max(0.02, baseA - offset);
  const pD = Math.max(0.02, baseD + offset);
  const total = pA + baseP + pD;
  const t = rng() * total;
  if (t < pA) return 1;
  if (t < pA + baseP) return 0;
  return -1;
}

async function api(path, { method = "GET", body, token } = {}) {
  const response = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${data?.error}`);
  return data;
}

async function main() {
  console.log(`目標站點：${BASE}`);
  const seedTexts = LANG === "en" ? STATEMENTS_EN : STATEMENTS.map(([text]) => text);
  const created = await api("/api/conversations", {
    method: "POST",
    body: {
      title: META[LANG].title,
      description: META[LANG].description,
      seedStatements: seedTexts,
      autoApprove: false, // 訪客提出的陳述需審核（公開政治議題 demo 的保守設定）
      allowSubmissions: true,
      openData: true, // 匿名化 CSV 任何人可下載
    },
  });
  const cid = created.conversationId;
  console.log(`已建立對話 ${cid}`);

  const pub = await api(`/api/conversations/${cid}/statements-public`);
  const sids = pub.statements.map((s) => s.sid);
  if (sids.length !== STATEMENTS.length) throw new Error("種子陳述數不符");

  const legislators = buildLegislators();
  let voteCount = 0;
  const queue = [...legislators];
  const workers = Array.from({ length: 8 }, async () => {
    for (;;) {
      const leg = queue.shift();
      if (!leg) return;
      leg.pid = crypto.randomUUID();
      for (let j = 0; j < STATEMENTS.length; j++) {
        const probsByBloc = STATEMENTS[j][1];
        const probs = probsByBloc[leg.bloc] ?? probsByBloc.blue; // 無黨籍沿用藍營基準
        const extraPass = leg.bloc === "ind" && rng() < 0.15;
        const value = extraPass ? 0 : sampleVote(probs, leg.offset);
        await api(`/api/conversations/${cid}/votes`, {
          method: "POST",
          body: { pid: leg.pid, sid: sids[j], value },
        });
        voteCount++;
        if (voteCount % 300 === 0) console.log(`  已投 ${voteCount} 票…`);
      }
    }
  });
  await Promise.all(workers);
  console.log(`完成：${legislators.length} 位模擬立委、${voteCount} 票`);

  const results = await api(`/api/conversations/${cid}/results`);
  const r = results.result;
  console.log(`分群 k=${r.k}，各群人數 [${r.groups.map((g) => g.size).join(", ")}]，silhouette=${r.silhouette}`);

  console.log("\n連結：");
  console.log(`  參與：${BASE}/c/${cid}`);
  console.log(`  結果：${BASE}/r/${cid}`);
  console.log(`  管理：${BASE}${created.urls.admin}`);
  console.log("（管理金鑰只顯示這一次，請保存；本腳本不寫入任何檔案。）");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
