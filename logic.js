// どてらい金融 — ゲームの計算部分。画面には触らない（ブラウザとNodeの両方で動く）。
//
// 用語
//   S          … 支払いサイクル。10日サイクルは 10S。
//   ジャンプ金 … 1回の期日に払う利息。元金残高 × 利率（円未満切り捨て）。
//   ジャンプ   … ジャンプ金だけ入れて、期日を次に送ること。
//   元金を詰める … ジャンプ金より多く入れた分で元金を減らすこと。
//   完済金額   … 元金残高 + 未払いジャンプ金 + その期日のジャンプ金。
//
// 期日の数え方（当日から換算）
//   貸した日・ジャンプした日を1日目と数える。10日に10Sで貸すと期日は19日、
//   19日にジャンプすると次の期日は28日。つまり期日の間隔は S−1 日。
//   1S だけは当日返済になってしまうので、翌日を期日にする（2S と同じ間隔）。
//   間隔は S−1 日でも、ジャンプ金は S 日分として計算する（10S なら10日分）。
//
// 不明入金
//   誰からかわからない入金。仮受金として預かり、持ち主がわかったら手動で貸付に充当する。
//   充当するまでは自分のお金ではないので、総資産には数えない。
(function (root) {
  'use strict';

  // 金額はすべて円（整数）。台帳CSVの金額は万円で書かれているので、読み込み時に円へ直す。
  const CONFIG = {
    days: 30,
    startDate: '2026-11-01',  // 1日目の日付（11月は30日あるので1か月ちょうど）
    startCash: 1000000,
    goal: 1500000,            // 30日目の総資産がこれ以上なら勝ち
    minCycle: 1,              // S の範囲
    maxCycle: 30,
    minRate: 10,              // 1Sあたりの利率（千分率。10 = 1%、1000 = 100%）
    maxRate: 1000,
    rateStep: 5,              // 0.5%刻み
    minLend: 10000,
    lendUnit: 1000,
    payUnit: 1000,            // 客は1,000円単位で入金してくる
    investigateCost: 30000,
    arrivalDays: [1, 2, 4, 6, 9],
    revisitDelay: 3,          // 完済した客が次に来るまでの日数
    revisitScale: 1.2,        // 再来店時の希望額の倍率（味をしめる）
    capRatio: 1.0,            // 10S分でかき集められる額 = 月収×1.0（±20%）。S に比例
    extraPayChance: 0.3,      // 余裕があるとき、ジャンプ金より多く入れて元金を詰めてくる確率
    guarantorPay: 150000,     // 保証人の肩代わり額の上限
    hitChance: 0.9,           // 弱みに合う取り立ての成功率
    baseChance: 0.3,          // 弱みに合わない取り立ての成功率（凄み1のとき）
    sugomiChance: 0.05,       // 凄み1つごとの成功率の上乗せ
    aisatsuPolice: 15,
    hoshoninPolice: 5,
    policeDecay: 2,           // 毎晩下がる警察の目
    nigePerFoot: 0.04,        // 夜逃げ率 = 逃げ足×0.04 + 延滞日数×0.03 + 金利の上乗せ − 凄み×0.02
    nigePerDay: 0.03,
    nigePerSugomi: 0.02,
    overdueValue: 0.5,        // 総資産に数えるときの延滞分の価値
    raidPolice: 50,           // 警察の手入れが起きはじめる警察の目
    raidChance: 0.25,
    fine: 150000,
    rivalCost: 50000,
    windfallScale: 3,         // 大当たりのときの隠し資産の倍率
    windfallFlat: 200000,     // 隠し資産がないときの大当たり額
    unknownChance: 0.07,      // 1日のうちに不明入金が入る確率（貸付があるとき）
    unknownMin: 5000,
    unknownMax: 30000,
    revealMin: 2,             // 不明入金の持ち主がわかるまでの日数
    revealMax: 5,
  };

  // よく使う条件。S と利率は自由に決められる。rate は千分率。
  const PRESETS = {
    toichi: { label: 'トイチ', cycle: 10, rate: 100 },
    tosan: { label: 'トサン', cycle: 10, rate: 300 },
    togo: { label: 'トゴ', cycle: 10, rate: 500 },
    hiichi: { label: 'ヒイチ', cycle: 1, rate: 100 },
  };

  const COMMANDS = {
    nakiotoshi: { label: '泣き落とし', weak: '情', note: '凄みが1下がる' },
    aisatsu: { label: 'ご近所に大声であいさつ', weak: '見栄', note: '警察の目+15' },
    hoshonin: { label: '保証人に連絡', weak: '家族', note: '保証人が逃げることも' },
  };

  const COLUMNS = {
    id: '顧客番号', name: '氏名', kana: 'ふりがな', age: '年齢', job: '職業',
    income: '月収(万円)', want: '希望額(万円)', claimReason: '申告した理由', realReason: '本当の理由',
    collateral: '担保', guarantor: '保証人', hidden: '隠し資産', hiddenAmount: '隠し資産額(万円)',
    weakType: '弱みタイプ', weak: '弱み', weakLine: '弱みを突かれた時の台詞',
    nige: '逃げ足(1-5)', uso: 'ウソつき度(1-5)', kuchiguse: '口癖',
  };
  const NUMERIC = ['age', 'income', 'want', 'hiddenAmount', 'nige', 'uso'];
  const MAN = ['income', 'want', 'hiddenAmount'];   // 万円 → 円に直す列

  const LINES = {
    success: ['しぶしぶ財布を開いた。', '「…分かりました、払います」', '泣きながら小銭まで数えだした。'],
    fail: ['居留守を使われた。テレビの音だけ聞こえる。', 'のらりくらりとかわされた。', '話の途中でトイレに逃げられた。'],
    nakiotoshi: 'あなたは玄関先で、自分の苦労話を涙ながらに語りはじめた。',
    aisatsu: 'あなたはアパート中に響く声で「どてらい金融でーす！ 毎度おおきに！」とあいさつした。',
  };

  // 取引明細の種類。cash は手持ち資金の増減の向き、pay は貸付への入金（充当）。
  const TX = {
    lend: { label: '貸付', cash: -1 },
    accrue: { label: 'ジャンプ金発生', cash: 0 },
    lateAccrue: { label: 'ジャンプ金発生（延滞中）', cash: 0 },
    earlyAccrue: { label: 'ジャンプ金発生（期日前の返済）', cash: 0 },
    jump: { label: 'ジャンプ', cash: 1, pay: true },
    jumpPlus: { label: 'ジャンプ＋元金詰め', cash: 1, pay: true },
    payoff: { label: '完済入金', cash: 1, pay: true },
    partial: { label: '一部入金（ジャンプ未達）', cash: 1, pay: true },
    collect: { label: '取り立て回収', cash: 1, pay: true },
    guarantor: { label: '保証人の肩代わり', cash: 1, pay: true },
    hidden: { label: '隠し資産の回収', cash: 1, pay: true },
    windfall: { label: '大当たりの返済', cash: 1, pay: true },
    allocate: { label: '不明入金の充当', cash: 0, pay: true },   // お金は不明入金のときに受け取り済み
    allocCancel: { label: '充当の取消', cash: 0, pay: true },     // 金額はマイナスで記録する
    overdue: { label: '延滞発生', cash: 0 },
    writeoff: { label: '貸倒（夜逃げ）', cash: 0 },
  };

  class GameError extends Error {}

  const floorTo = (x, unit) => Math.floor(x / unit) * unit;
  const yen = (n) => `${Math.round(n).toLocaleString('ja-JP')}円`;

  // 乱数（シードを状態に持つので、同じシードなら同じ展開になる）
  function rand(s) {
    s.seed = (s.seed + 0x6D2B79F5) >>> 0;
    let t = s.seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const pick = (s, arr) => arr[Math.floor(rand(s) * arr.length)];

  // ---- 日付 ----

  const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
  function dateOf(day) {
    const [y, m, d] = CONFIG.startDate.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + day - 1));
  }
  const weekdayOf = (day) => dateOf(day).getUTCDay();
  function fmtDay(day) {
    const t = dateOf(day);
    return `${t.getUTCMonth() + 1}/${t.getUTCDate()}(${WEEK[t.getUTCDay()]})`;
  }
  // 開始月から offset か月ずらした月（-1 = 前月、1 = 翌月）。firstDay はその月1日のゲーム内の日。
  function monthInfo(offset) {
    const [y, m] = CONFIG.startDate.split('-').map(Number);
    const first = new Date(Date.UTC(y, m - 1 + offset, 1));
    const start = dateOf(1);
    const daysInMonth = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    return {
      year: first.getUTCFullYear(), month: first.getUTCMonth() + 1, daysInMonth, lead: first.getUTCDay(),
      firstDay: Math.round((first - start) / 86400000) + 1,
    };
  }
  const horizonDay = () => { const n = monthInfo(1); return n.firstDay + n.daysInMonth - 1; }; // 翌月末

  function fmtDayLong(day) {
    const t = dateOf(day);
    return `${t.getUTCFullYear()}年${t.getUTCMonth() + 1}月${t.getUTCDate()}日（${WEEK[t.getUTCDay()]}）`;
  }

  // ---- 貸付条件 ----

  const stepOf = (cycle) => Math.max(1, cycle - 1);                  // 期日の間隔（当日から換算）
  const interestOf = (principal, rate) => Math.floor((principal * rate) / 1000); // ジャンプ金（円未満切り捨て）
  const per10 = (rate, cycle) => (rate / 1000) * 10 / cycle;   // 10日あたりに直した利率（ジャンプ金は S 日分）
  const aprOf = (rate, cycle) => (rate / 1000) * 365 / cycle;  // 年利換算（単利・S 日分として）
  const pctText = (rate) => (rate % 100 === 0 ? `${rate / 100}割` : `${rate / 10}%`);
  const termsDesc = (rate, cycle) => `${cycle}Sで${pctText(rate)}`;
  function termsLabel(rate, cycle) {
    const preset = Object.values(PRESETS).find((p) => p.rate === rate && p.cycle === cycle);
    return preset ? preset.label : termsDesc(rate, cycle);
  }
  const policeOf = (rate, cycle) => Math.max(0, Math.round(35 * per10(rate, cycle) - 5.5));
  function rateNige(rate, cycle) {
    const x = Math.max(0, per10(rate, cycle) - 0.1);
    return Math.min(0.5, 1.25 * x * x);
  }
  function checkTerms(rate, cycle) {
    if (!(Number.isInteger(cycle) && cycle >= CONFIG.minCycle && cycle <= CONFIG.maxCycle)) {
      throw new GameError(`Sは${CONFIG.minCycle}〜${CONFIG.maxCycle}で決めてください`);
    }
    if (!(Number.isInteger(rate) && rate >= CONFIG.minRate && rate <= CONFIG.maxRate && rate % CONFIG.rateStep === 0)) {
      throw new GameError(`利率は${CONFIG.minRate / 10}〜${CONFIG.maxRate / 10}%（0.5%刻み）で決めてください`);
    }
  }

  // ---- 台帳の読み込み ----

  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    const rows = [];
    let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') quoted = false;
        else field += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((f) => f.trim() !== ''));
  }

  function loadCustomers(text) {
    const rows = parseCSV(text);
    if (rows.length < 2) throw new GameError('台帳に客がいません');
    const head = rows[0].map((h) => h.trim());
    const idx = {};
    for (const [key, col] of Object.entries(COLUMNS)) {
      idx[key] = head.indexOf(col);
      if (idx[key] < 0) throw new GameError(`台帳に「${col}」の列がありません`);
    }
    return rows.slice(1).map((r, n) => {
      const c = {};
      for (const key in idx) c[key] = (r[idx[key]] || '').trim();
      for (const key of NUMERIC) {
        const v = Number(c[key]);
        if (c[key] === '' || !Number.isFinite(v)) throw new GameError(`台帳${n + 2}行目の「${COLUMNS[key]}」が数字ではありません`);
        c[key] = MAN.includes(key) ? Math.round(v * 10000) : v;
      }
      // ウソつきほど月収を盛って申告する
      c.declaredIncome = floorTo(c.income * (1 + (c.uso - 1) * 0.25), 1000);
      return c;
    });
  }

  // ---- 状態 ----

  function newGame(customers, seed) {
    const s = {
      v: 5, day: 0, cash: CONFIG.startCash, sugomi: 1, police: 0, seed: seed >>> 0, unknowns: [], nextUnknownId: 1,
      customers, people: {}, loans: [], txs: [], visitor: null, nightUsed: false, log: [], over: null,
      nextLoanId: 1, nextTxId: 1,
    };
    const days = customers.map((_, i) => CONFIG.arrivalDays[i] || 10 + 2 * (i - CONFIG.arrivalDays.length));
    for (let i = days.length - 1; i > 0; i--) {
      const j = Math.floor(rand(s) * (i + 1));
      [days[i], days[j]] = [days[j], days[i]];
    }
    customers.forEach((c, i) => {
      s.people[c.id] = {
        nextVisit: days[i], want: c.want, investigated: false, hiddenUsed: false,
        guarantorGone: false, refused: false, visits: 0, memo: '',
      };
    });
    startDay(s);
    return s;
  }

  const customerOf = (s, id) => s.customers.find((c) => c.id === id);
  const loanOf = (s, id) => s.loans.find((l) => l.id === id);
  const visitorOf = (s) => (s.visitor ? customerOf(s, s.visitor) : null);
  const isActive = (loan) => loan.status === '返済中' || loan.status === '延滞';
  const hasGuarantor = (s, c) => c.guarantor !== 'なし' && !s.people[c.id].guarantorGone;
  const log = (s, kind, text) => s.log.push({ day: s.day, kind, text });
  const owedOf = (loan) => loan.principal + loan.accrued;
  const nextJumpOf = (loan) => interestOf(loan.principal, loan.rate);

  // 期日にかき集められる額（1,000円単位）
  function capOf(s, c, cycle) {
    return floorTo(c.income * CONFIG.capRatio * (cycle / 10) * (0.8 + 0.4 * rand(s)), CONFIG.payUnit);
  }

  // 期日ごとにかき集められる額の目安（画面の判断材料）
  function capRange(c, cycle, real) {
    const base = (real ? c.income : c.declaredIncome) * CONFIG.capRatio * (cycle / 10);
    return [floorTo(base * 0.8, CONFIG.payUnit), floorTo(base * 1.2, CONFIG.payUnit)];
  }

  function tx(s, loan, type, amount, parts) {
    s.txs.push({
      id: s.nextTxId++, day: s.day, loanId: loan.id, customerId: loan.customerId, type, amount,
      toInterest: (parts && parts.toInterest) || 0, toPrincipal: (parts && parts.toPrincipal) || 0,
      principal: loan.principal, accrued: loan.accrued,
    });
  }

  function close(s, loan, status) {
    loan.status = status;
    loan.closedDay = s.day;
    if (status === '完済') {
      const p = s.people[loan.customerId];
      p.nextVisit = s.day + CONFIG.revisitDelay;
      p.want = Math.max(CONFIG.minLend, floorTo(p.want * CONFIG.revisitScale, 10000));
    }
  }

  // 入金はジャンプ金（未払い分）に先に充当し、多い分で元金を詰める。
  // type が 'due'（期日の入金）のときは、中身に合わせてジャンプ／ジャンプ＋元金詰め／完済／一部入金に分ける。
  function pay(s, loan, amount, type, noCash) {
    amount = Math.min(Math.floor(amount), owedOf(loan));
    if (amount <= 0) return 0;
    const jumpDue = loan.accrued;
    const toInterest = Math.min(amount, loan.accrued);
    const toPrincipal = amount - toInterest;
    loan.accrued -= toInterest;
    loan.principal -= toPrincipal;
    loan.collected += amount;
    loan.interestPaid += toInterest;
    if (!noCash) s.cash += amount;
    const closed = loan.principal <= 0 && loan.accrued <= 0;
    if (type === 'due') {
      if (closed) type = 'payoff';
      else if (amount < jumpDue) type = 'partial';
      else { type = toPrincipal > 0 ? 'jumpPlus' : 'jump'; loan.jumps++; }
    }
    tx(s, loan, type, amount, { toInterest, toPrincipal });
    if (closed) {
      loan.principal = 0;
      loan.accrued = 0;
      close(s, loan, '完済');
    }
    return amount;
  }

  function accrue(s, loan, type) {
    const interest = nextJumpOf(loan);
    if (interest <= 0) return 0;
    loan.accrued += interest;
    tx(s, loan, type, interest);
    return interest;
  }

  function startDay(s) {
    s.day++;
    s.nightUsed = false;
    for (const loan of s.loans) {
      if (loan.due !== s.day) continue;
      if (loan.status === '返済中') settleDue(s, loan);
      else if (loan.status === '延滞') {
        // 延滞中も、期日が来るたびにジャンプ金は発生する
        const c = customerOf(s, loan.customerId);
        const interest = accrue(s, loan, 'lateAccrue');
        loan.due += stepOf(loan.cycle);
        if (interest > 0) log(s, 'bad', `${c.name}の延滞中に期日が来た。ジャンプ金${yen(interest)}が未払いに加わった（未払い計${yen(loan.accrued)}）。`);
      }
    }
    unknownEvents(s);
    const waiting = s.customers.filter((c) => !s.people[c.id].refused && s.people[c.id].nextVisit === s.day);
    waiting.slice(1).forEach((c) => s.people[c.id].nextVisit++);
    if (waiting.length) {
      const c = waiting[0], p = s.people[c.id];
      p.nextVisit = null;
      p.visits++;
      s.visitor = c.id;
      const again = p.visits > 1 ? 'また' : '';
      log(s, 'visit', `${c.name}が${again}来店。「${c.claimReason}で、${yen(p.want)}貸してください…」`);
    }
  }

  // 不明入金：誰からかわからない入金が入る。数日後、持ち主から電話があって判明する。
  const unknownLeft = (u) => u.amount - u.allocated - u.refunded;

  function unknownEvents(s) {
    for (const u of s.unknowns) {
      if (u.revealed || u.revealDay !== s.day || unknownLeft(u) <= 0) continue;
      u.revealed = true;
      const c = customerOf(s, u.ownerId);
      log(s, 'visit', `${c.name}から電話。「${fmtDay(u.day)}に${yen(u.amount)}多めに入れといたで。ちゃんと引いといてや」——不明入金の持ち主がわかった。元金表かカレンダーから充当できる。`);
    }
    const active = s.loans.filter(isActive);
    if (!active.length || rand(s) >= CONFIG.unknownChance) return;
    const loan = pick(s, active);
    const steps = (CONFIG.unknownMax - CONFIG.unknownMin) / CONFIG.payUnit;
    const amount = CONFIG.unknownMin + Math.floor(rand(s) * (steps + 1)) * CONFIG.payUnit;
    const reveal = CONFIG.revealMin + Math.floor(rand(s) * (CONFIG.revealMax - CONFIG.revealMin + 1));
    s.unknowns.push({
      id: s.nextUnknownId++, day: s.day, amount, allocated: 0, refunded: 0, allocations: [], refunds: [],
      ownerId: loan.customerId, revealDay: s.day + reveal, revealed: false,
    });
    s.cash += amount;
    log(s, 'info', `差出人のわからない入金が${yen(amount)}あった。不明入金として預かる（持ち主がわかるまで充当しない）。`);
  }

  const unknownOf = (s, id) => s.unknowns.find((u) => u.id === id);

  // 不明入金を貸付に手動で充当する。ジャンプ金に先に充て、多い分で元金を詰める。
  function allocateUnknown(s, unknownId, loanId, amount) {
    const u = unknownOf(s, unknownId);
    if (!u) throw new GameError('その不明入金は見つかりません');
    const left = unknownLeft(u);
    if (left <= 0) throw new GameError('この不明入金はもう残っていません（充当か返金が済んでいます）');
    const loan = loanOf(s, loanId);
    if (!loan || !isActive(loan)) throw new GameError('充当できるのは返済中か延滞中の貸付だけです');
    const owed = owedOf(loan);
    if (!(Number.isInteger(amount) && amount >= 1 && amount <= Math.min(left, owed))) {
      throw new GameError(`充当できるのは1円〜${yen(Math.min(left, owed))}です`);
    }
    const c = customerOf(s, loan.customerId), p = s.people[c.id];
    // 取り消しのときに戻せるよう、充当前の状態を控えておく
    const before = {
      status: loan.status, due: loan.due, overdueDays: loan.overdueDays, closedDay: loan.closedDay,
      nextVisit: p.nextVisit, want: p.want, visits: p.visits,
    };
    const jumpBefore = loan.accrued;
    pay(s, loan, amount, 'allocate', true);
    const t = s.txs[s.txs.length - 1];
    u.allocated += amount;
    u.allocations.push({ day: s.day, loanId: loan.id, amount, txId: t.id, before, canceled: false, canceledDay: null });
    const toJump = Math.min(amount, jumpBefore);
    let text = `${fmtDay(u.day)}の不明入金から${yen(amount)}を${c.name}（No.${loan.id}）に充当。ジャンプ(${yen(toJump)})＋元金詰め(${yen(amount - toJump)})。`;
    if (loan.status === '完済') text += 'これで完済！';
    else if (before.status === '延滞' && loan.accrued === 0) {
      // 未払いのジャンプ金がなくなったので延滞は解消。今日を1日目として期日を数え直す
      loan.status = '返済中';
      loan.overdueDays = 0;
      loan.due = s.day + stepOf(loan.cycle);
      text += `延滞が解消。次回の期日は${fmtDay(loan.due)}。`;
    }
    log(s, 'plus', text);
  }

  // 充当を取り消せるか。あとから同じ貸付に取引があると、その計算が狂うので取り消せない。
  function canCancelAllocation(s, unknownId, index) {
    const u = unknownOf(s, unknownId);
    const a = u && u.allocations[index];
    if (!a) return { ok: false, reason: 'その充当は見つかりません' };
    if (a.canceled) return { ok: false, reason: 'もう取り消してあります' };
    const loan = loanOf(s, a.loanId);
    const last = s.txs.filter((t) => t.loanId === loan.id).pop();
    if (!last || last.id !== a.txId) return { ok: false, reason: 'この充当のあとに同じ貸付の取引があるため、取り消せません' };
    if (loan.status === '夜逃げ') return { ok: false, reason: '夜逃げした貸付の充当は取り消せません' };
    if (loan.status === '完済') {
      const p = s.people[loan.customerId];
      if (p.visits > a.before.visits || s.visitor === loan.customerId) return { ok: false, reason: '完済後にもう再来店しているため、取り消せません' };
    }
    return { ok: true, reason: '' };
  }

  // 充当の取り消し。逆向きの取引「充当の取消」を記録して、充当前の残高と状態に戻す。
  function cancelAllocation(s, unknownId, index) {
    const check = canCancelAllocation(s, unknownId, index);
    if (!check.ok) throw new GameError(check.reason);
    const u = unknownOf(s, unknownId), a = u.allocations[index];
    const loan = loanOf(s, a.loanId), c = customerOf(s, loan.customerId), p = s.people[c.id];
    const orig = s.txs.find((t) => t.id === a.txId);
    const closedByThis = loan.status === '完済';
    loan.principal += orig.toPrincipal;
    loan.accrued += orig.toInterest;
    loan.collected -= orig.amount;
    loan.interestPaid -= orig.toInterest;
    loan.status = a.before.status;
    loan.due = a.before.due;
    loan.closedDay = a.before.closedDay;
    loan.overdueDays = a.before.status === '延滞' ? a.before.overdueDays + (s.day - a.day) : a.before.overdueDays;
    if (closedByThis) {
      // この充当で完済→再来店の予定が入っていたので、それも取り消す
      p.nextVisit = a.before.nextVisit;
      p.want = a.before.want;
    }
    u.allocated -= orig.amount;
    a.canceled = true;
    a.canceledDay = s.day;
    tx(s, loan, 'allocCancel', -orig.amount, { toInterest: -orig.toInterest, toPrincipal: -orig.toPrincipal });
    log(s, 'minus', `${fmtDay(a.day)}の充当（${c.name} No.${loan.id} へ${yen(orig.amount)}）を取り消した。ジャンプ(${yen(orig.toInterest)})＋元金詰め(${yen(orig.toPrincipal)})を充当前に戻し、${yen(orig.amount)}は不明入金（未充当）に戻った。`);
    // 延滞に戻した結果、本来ジャンプ金が発生する日を過ぎていたら、今日まとめて計上する
    if (loan.status === '延滞') {
      while (loan.due <= s.day) {
        const i = accrue(s, loan, 'lateAccrue');
        log(s, 'bad', `${c.name}の延滞中の期日（${fmtDay(loan.due)}）の分、ジャンプ金${yen(i)}を計上した。`);
        loan.due += stepOf(loan.cycle);
      }
    }
  }

  // 返金（組戻し）。未充当の残りを全額返す。
  function refundUnknown(s, unknownId) {
    const u = unknownOf(s, unknownId);
    if (!u) throw new GameError('その不明入金は見つかりません');
    const left = unknownLeft(u);
    if (left <= 0) throw new GameError('返金できる残りがありません');
    if (s.cash < left) throw new GameError(`手持ち資金が足りません（返金額 ${yen(left)}）`);
    s.cash -= left;
    u.refunded += left;
    u.refunds.push({ day: s.day, amount: left });
    log(s, 'minus', `${fmtDay(u.day)}の不明入金のうち、未充当の${yen(left)}を返金（組戻し）した。`);
  }

  // 期日の処理。paid を渡すと、客がその額を入金したことにする（検証用）。
  function settleDue(s, loan, paid) {
    const c = customerOf(s, loan.customerId);
    accrue(s, loan, 'accrue');
    const jumpDue = loan.accrued;
    const owed = owedOf(loan);
    if (paid === undefined) {
      const cap = capOf(s, c, loan.cycle);
      if (cap >= owed) paid = owed;
      else if (cap >= jumpDue) paid = rand(s) < CONFIG.extraPayChance ? cap : jumpDue; // 基本はジャンプ金だけ
      else paid = 0;
    }
    paid = Math.min(Math.floor(paid), owed);

    if (paid >= owed) {
      pay(s, loan, paid, 'due');
      log(s, 'plus', `${c.name}が完済金額${yen(paid)}を入れてきた。完済！`);
    } else if (paid >= jumpDue) {
      pay(s, loan, paid, 'due');
      loan.due += stepOf(loan.cycle);
      const extra = paid - jumpDue;
      const next = `次回の期日は${fmtDay(loan.due)}、ジャンプ金は${yen(nextJumpOf(loan))}。`;
      log(s, 'plus', extra > 0
        ? `${c.name}が${yen(paid)}を入金。ジャンプ金${yen(jumpDue)}に充当し、残り${yen(extra)}で元金を詰めた（元金残り${yen(loan.principal)}）。${next}`
        : `${c.name}がジャンプ金${yen(jumpDue)}を入れてジャンプ。${next}`);
    } else {
      if (paid > 0) pay(s, loan, paid, 'due');
      loan.status = '延滞';
      loan.overdueDays = 0;
      loan.due += stepOf(loan.cycle);   // 延滞中に次のジャンプ金が発生する日
      tx(s, loan, 'overdue', 0);
      log(s, 'bad', paid > 0
        ? `${c.name}が${yen(paid)}だけ持ってきた。ジャンプ金に届かず延滞。未払いジャンプ金は${yen(loan.accrued)}。`
        : `${c.name}が期日に来ない。電話にも出ない。未払いジャンプ金は${yen(loan.accrued)}。`);
    }
  }

  // ---- プレイヤーの行動 ----

  function investigate(s) {
    const c = visitorOf(s);
    if (!c) throw new GameError('来店中の客がいません');
    const p = s.people[c.id];
    if (p.investigated) throw new GameError('もう調べてあります');
    if (s.cash < CONFIG.investigateCost) throw new GameError('調査費が足りません');
    s.cash -= CONFIG.investigateCost;
    p.investigated = true;
    log(s, 'info', `身辺調査に${yen(CONFIG.investigateCost)}。${c.name}の本当の借金理由は「${c.realReason}」だった。`);
  }

  function lendLimit(s) {
    const c = visitorOf(s);
    return c ? floorTo(Math.min(s.people[c.id].want, s.cash), CONFIG.lendUnit) : 0;
  }

  // 貸す前の見積もり（画面のプレビュー用）。ジャンプし続けた場合の見込み。
  function quote(s, amount, rate, cycle) {
    const interest = interestOf(amount, rate);
    const step = stepOf(cycle);
    const due = s.day + step;
    let dues = 0;
    for (let d = due; d <= CONFIG.days; d += step) dues++;
    return {
      due, nextDue: due + step, step, interest, payoff: amount + interest, dues, expected: interest * dues,
      per10: per10(rate, cycle), apr: aprOf(rate, cycle), police: policeOf(rate, cycle), nige: rateNige(rate, cycle),
    };
  }

  function lend(s, amount, rate, cycle) {
    const c = visitorOf(s);
    if (!c) throw new GameError('来店中の客がいません');
    checkTerms(rate, cycle);
    const limit = lendLimit(s);
    if (!(Number.isInteger(amount) && amount >= CONFIG.minLend && amount % CONFIG.lendUnit === 0 && amount <= limit)) {
      throw new GameError(`貸せるのは${yen(CONFIG.minLend)}〜${yen(limit)}（${yen(CONFIG.lendUnit)}単位）です`);
    }
    s.cash -= amount;
    s.police += policeOf(rate, cycle);
    const loan = {
      id: s.nextLoanId++, customerId: c.id, lent: amount, principal: amount, accrued: 0, rate, cycle,
      lentDay: s.day, due: s.day + stepOf(cycle), status: '返済中', overdueDays: 0, jumps: 0,
      collected: 0, interestPaid: 0, writtenOff: 0, closedDay: null,
    };
    s.loans.push(loan);
    tx(s, loan, 'lend', amount);
    s.visitor = null;
    const interest = interestOf(amount, rate);
    const named = termsLabel(rate, cycle) === termsDesc(rate, cycle) ? termsDesc(rate, cycle) : `${termsLabel(rate, cycle)}（${termsDesc(rate, cycle)}）`;
    log(s, 'minus', `${c.name}に${yen(amount)}を${named}で貸した。完済金額${yen(amount + interest)}、初回の期日は${fmtDay(loan.due)}（ジャンプ金${yen(interest)}）。`);
    log(s, 'line', `${c.name}「${c.kuchiguse}」`);
    return loan;
  }

  function refuse(s) {
    const c = visitorOf(s);
    if (!c) throw new GameError('来店中の客がいません');
    s.people[c.id].refused = true;
    s.visitor = null;
    log(s, 'info', `${c.name}を追い返した。「${c.kuchiguse}」と言い残して帰っていった。`);
  }

  function collect(s, loanId, cmdKey) {
    const loan = loanOf(s, loanId);
    const cmd = COMMANDS[cmdKey];
    if (!loan || loan.status !== '延滞') throw new GameError('延滞している客ではありません');
    if (!cmd) throw new GameError('取り立て方を選んでください');
    if (s.nightUsed) throw new GameError('今夜はもう動けません');
    const c = customerOf(s, loan.customerId), p = s.people[c.id];
    if (cmdKey === 'hoshonin' && !hasGuarantor(s, c)) throw new GameError('連絡できる保証人がいません');
    s.nightUsed = true;

    const hit = c.weakType === cmd.weak;
    const success = rand(s) < (hit ? CONFIG.hitChance : CONFIG.baseChance + CONFIG.sugomiChance * (s.sugomi - 1));

    if (cmdKey === 'nakiotoshi') { log(s, 'info', LINES.nakiotoshi); s.sugomi = Math.max(1, s.sugomi - 1); }
    if (cmdKey === 'aisatsu') { log(s, 'info', LINES.aisatsu); s.police += CONFIG.aisatsuPolice; }
    if (cmdKey === 'hoshonin') { log(s, 'info', `保証人の${c.guarantor}に電話をかけた。`); s.police += CONFIG.hoshoninPolice; }

    if (!success) {
      log(s, 'line', `${c.name}「${c.kuchiguse}」`);
      log(s, 'bad', `${pick(s, LINES.fail)} 回収できなかった。`);
    } else {
      log(s, 'line', hit ? `${c.name}「${c.weakLine}」` : `${c.name}は${pick(s, LINES.success)}`);
      let total = pay(s, loan, capOf(s, c, loan.cycle), 'collect');
      if (cmdKey === 'hoshonin' && loan.status === '延滞') {
        const g = pay(s, loan, CONFIG.guarantorPay, 'guarantor');
        if (g > 0) { total += g; log(s, 'info', `${c.guarantor}が${yen(g)}を肩代わりした。`); }
      }
      if (hit && !p.hiddenUsed && c.hiddenAmount > 0 && loan.status === '延滞') {
        p.hiddenUsed = true;
        total += pay(s, loan, c.hiddenAmount, 'hidden');
        log(s, 'info', `隠していた「${c.hidden}」まで差し出してきた。`);
      }
      if (loan.status === '完済') {
        log(s, 'plus', `${yen(total)}を回収。${c.name}の借金はこれで完済！`);
      } else {
        // 回収した日を1日目として、次の期日を数え直す
        loan.status = '返済中';
        loan.overdueDays = 0;
        loan.due = s.day + stepOf(loan.cycle);
        log(s, 'plus', `${yen(total)}を回収。残りは元金${yen(loan.principal)}・未払いジャンプ金${yen(loan.accrued)}。次回の期日は${fmtDay(loan.due)}。`);
      }
      if (cmdKey !== 'nakiotoshi') s.sugomi = Math.min(5, s.sugomi + 1);
    }

    if (cmdKey === 'hoshonin' && hasGuarantor(s, c) && rand(s) < 0.2) {
      p.guarantorGone = true;
      log(s, 'bad', `${c.guarantor}が電話番号を変えた。もう連絡できない。`);
    }
  }

  function setMemo(s, customerId, text) {
    if (!s.people[customerId]) throw new GameError('その客は台帳にいません');
    s.people[customerId].memo = String(text).slice(0, 2000);
  }

  function nigeChance(s, loan) {
    const c = customerOf(s, loan.customerId);
    const p = CONFIG.nigePerFoot * c.nige + CONFIG.nigePerDay * loan.overdueDays
      + rateNige(loan.rate, loan.cycle) - CONFIG.nigePerSugomi * s.sugomi;
    return Math.min(0.9, Math.max(0, p));
  }

  function endDay(s) {
    if (s.over) throw new GameError('勝負はもう終わっています');
    if (s.visitor) throw new GameError('来店した客への返事がまだです');

    for (const loan of s.loans.filter((l) => l.status === '延滞')) {
      const c = customerOf(s, loan.customerId);
      loan.overdueDays++;
      if (rand(s) < nigeChance(s, loan)) {
        loan.writtenOff = owedOf(loan);
        tx(s, loan, 'writeoff', loan.writtenOff);
        close(s, loan, '夜逃げ');
        log(s, 'bad', `${c.name}が夜逃げした。部屋には「${c.kuchiguse}」と書かれた置き手紙だけ。${yen(loan.writtenOff)}が焦げついた。`);
      }
    }

    townEvent(s);
    s.police = Math.max(0, s.police - CONFIG.policeDecay);

    const active = s.loans.some(isActive);
    if (s.cash < CONFIG.minLend && !active) s.over = { win: false, reason: '貸す金も、取り立てる相手もいない。どてらい金融、倒産。' };
    else if (s.police >= 100) s.over = { win: false, reason: '警察の目が限界を超えた。ガサ入れで店じまい。' };
    else if (s.day >= CONFIG.days) {
      const a = totalAssets(s);
      s.over = a >= CONFIG.goal
        ? { win: true, reason: `30日で総資産${yen(a)}。目標の${yen(CONFIG.goal)}を超えた！` }
        : { win: false, reason: `30日で総資産${yen(a)}。目標の${yen(CONFIG.goal)}に届かなかった。` };
    }
    if (s.over) log(s, s.over.win ? 'plus' : 'bad', s.over.reason);
    else startDay(s);
  }

  function townEvent(s) {
    if (s.police >= CONFIG.raidPolice && rand(s) < CONFIG.raidChance) {
      const fine = Math.min(CONFIG.fine, s.cash);
      s.cash -= fine;
      s.police = Math.max(0, s.police - 30);
      log(s, 'bad', `警察の手入れ。帳簿を突っつかれて罰金${yen(fine)}。`);
      return;
    }
    const r = rand(s);
    const active = s.loans.filter(isActive);
    if (r < 0.05) {
      const cost = Math.min(CONFIG.rivalCost, s.cash);
      s.cash -= cost;
      log(s, 'bad', `向かいにライバルの「にこにこローン」が開店。チラシ合戦で${yen(cost)}かかった。`);
    } else if (r < 0.1 && active.length) {
      const loan = pick(s, active);
      const c = customerOf(s, loan.customerId), p = s.people[c.id];
      let amount = CONFIG.windfallFlat, text = `${c.name}が競馬で万馬券を当てた！`;
      if (!p.hiddenUsed && c.hiddenAmount > 0) {
        p.hiddenUsed = true;
        amount = c.hiddenAmount * CONFIG.windfallScale;
        text = `${c.name}の「${c.hidden}」が大化けした！`;
      }
      const got = earlyPay(s, loan, amount);
      log(s, 'plus', `${text} 慌てて${yen(got)}を返しにきた。${loan.status === '完済' ? '完済！' : ''}`);
    }
  }

  // 期日前の返済（大当たりなど）。
  //   ジャンプ金以上を持ってきた → その日にジャンプした扱い。今回分のジャンプ金を取り、残りで元金を詰め、
  //                               今日を1日目に期日を数え直す（全部返せば完済金額＝元金＋ジャンプ金）。
  //   ジャンプ金に満たない       → まだジャンプ金は発生していないので、全額で元金を詰める（期日はそのまま）。
  //   延滞中                     → 未払いジャンプ金に先に充て、払い終われば今日から数え直す。
  function earlyPay(s, loan, amount) {
    const earlyJump = loan.status === '返済中' && amount >= nextJumpOf(loan);
    if (earlyJump) accrue(s, loan, 'earlyAccrue');
    const got = pay(s, loan, amount, 'windfall');
    if (loan.status === '返済中' && !earlyJump) return got;
    if (loan.status !== '完済' && loan.accrued === 0) {
      loan.status = '返済中';
      loan.overdueDays = 0;
      loan.due = s.day + stepOf(loan.cycle);
    }
    return got;
  }

  // ---- 集計（台帳・カレンダー・元金表で使う） ----

  // 貸付は元金だけを数える（未払いジャンプ金は回収するまで資産に数えない）
  function totalAssets(s) {
    let a = s.cash;
    for (const l of s.loans) {
      if (l.status === '返済中') a += l.principal;
      if (l.status === '延滞') a += l.principal * CONFIG.overdueValue;
    }
    for (const u of s.unknowns) a -= unknownLeft(u);   // 不明入金は預かり金
    return Math.round(a);
  }

  function totals(s) {
    const t = { lent: 0, balance: 0, accrued: 0, interestPaid: 0, principalBack: 0, collected: 0, writtenOff: 0, active: 0, overdue: 0, jumps: 0, unknownHeld: 0, unknownOpen: 0 };
    for (const u of s.unknowns) {
      t.unknownHeld += unknownLeft(u);
      if (unknownLeft(u) > 0) t.unknownOpen++;
    }
    for (const l of s.loans) {
      t.lent += l.lent;
      t.interestPaid += l.interestPaid;
      t.collected += l.collected;
      t.writtenOff += l.writtenOff;
      t.jumps += l.jumps;
      t.principalBack += l.lent - l.principal;   // 回収累計 = ジャンプ金累計 + 回収済元金
      if (isActive(l)) { t.balance += l.principal; t.accrued += l.accrued; t.active++; }
      if (l.status === '延滞') t.overdue++;
    }
    return t;
  }

  // これからの期日（ジャンプし続けた場合の見込み）。日付 → 予定の配列。horizon までの日を出す
  function schedule(s, horizon) {
    const last = horizon || CONFIG.days;
    const map = {};
    for (const loan of s.loans) {
      if (loan.status !== '返済中') continue;
      const step = stepOf(loan.cycle);
      const interest = nextJumpOf(loan);
      let first = true;
      for (let d = loan.due; d <= last; d += step) {
        (map[d] = map[d] || []).push({
          loan, customer: customerOf(s, loan.customerId), first,
          jump: interest + (first ? loan.accrued : 0),
          payoff: loan.principal + interest + (first ? loan.accrued : 0),
        });
        first = false;
      }
    }
    return map;
  }

  function ledger(s) {
    return s.customers.map((c) => {
      const p = s.people[c.id];
      const loans = s.loans.filter((l) => l.customerId === c.id);
      const loan = loans[loans.length - 1] || null;
      let status = loan ? loan.status : 'まだ来ていない';
      if (s.visitor === c.id) status = '来店中';
      else if (p.refused && !loan) status = '断った';
      const active = loans.filter(isActive);
      const dues = active.filter((l) => l.status === '返済中').map((l) => l.due);
      return {
        c, p, loans, loan, status,
        balance: active.reduce((a, l) => a + l.principal, 0),
        accrued: active.reduce((a, l) => a + l.accrued, 0),
        nextDue: dues.length ? Math.min(...dues) : null,
        collected: loans.reduce((a, l) => a + l.collected, 0),
        interestPaid: loans.reduce((a, l) => a + l.interestPaid, 0),
        principalBack: loans.reduce((a, l) => a + l.lent - l.principal, 0),
        lent: loans.reduce((a, l) => a + l.lent, 0),
        jumps: loans.reduce((a, l) => a + l.jumps, 0),
      };
    });
  }

  const api = {
    CONFIG, PRESETS, COMMANDS, TX, GameError, parseCSV, loadCustomers, newGame,
    investigate, lend, lendLimit, quote, refuse, collect, setMemo, endDay,
    totalAssets, totals, schedule, ledger, nigeChance, capRange, owedOf, nextJumpOf, isActive,
    visitorOf, customerOf, loanOf, hasGuarantor,
    fmtDay, fmtDayLong, weekdayOf, termsLabel, termsDesc, pctText, per10, aprOf, policeOf, rateNige,
    stepOf, interestOf, yen, monthInfo, horizonDay, allocateUnknown, unknownOf, unknownLeft,
    canCancelAllocation, cancelAllocation, refundUnknown,
    _settleDue: settleDue,   // 検証用：期日の入金額を指定して処理する
    _earlyPay: earlyPay,     // 検証用：期日前の返済を処理する
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Game = api;
})(this);
