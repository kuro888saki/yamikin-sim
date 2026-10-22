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
//   期日は貸した日から決まった並び（10日・19日・28日…）で、払った日によってずれない。
//   延滞した客が後日ジャンプ金を満額払ってジャンプしても、次回の期日は元の予定どおり
//   （10日が期日で5日遅れて15日にジャンプしても、次は24日ではなく19日）。
//   間隔は S−1 日でも、ジャンプ金は S 日分として計算する（10S なら10日分）。
//
// 不明入金
//   誰からかわからない入金。仮受金として預かり、持ち主がわかったら手動で貸付に充当する。
//   充当するまでは自分のお金ではないので、純利にも貸付総元金にも数えない。
//
// 不渡りと純利
//   夜逃げした客は連絡がつかない（連絡不通）。期日から2週間以上遅れていて連絡がつかない客は不渡りにする。
//   不渡りを引くのは毎月15日と月末の締め。そこで不渡りになった元金を貸付総元金から引く。
//   それまでは夜逃げした客の元金も貸付総元金に残る（未計上）。
//   純利 = 総売上（回収したジャンプ金＋振込手数料）− 経費（身辺調査・罰金・チラシ代）− 不渡り（元金）。目指すのは純利。
//
// 受付表記（貸付条件）
//   ①元金-完済金（万円）②S ③初回の期日 ④振込金額 ⑤振込先口座 の5点で決める。
//   例：①5-6.5 ②10S ③初回11/10 ④振込金額45,000円 → 元金50,000円・完済金65,000円（利息15,000円＝3割）。
//   元金と振込金額の差（5,000円）は振込手数料として、貸した日に売上に計上する。
//   元金を詰めたあとのジャンプ金は、元金残高 × 利息/元金（①の比率。円未満切り捨て）。
//
// 期間
//   既定は1年（11/1〜翌年10/31）。最終日は締め日（15日か月末）にして、途中でも自由に延ばせる。
//
// 早送り
//   予定（来店・期日・締め・延滞）のない日を続けて終え、次に予定がある日で止める。
//
// 顧客カルテ
//   基本情報・勤務先・保証人・緊急連絡先（3名）・流入元などを自由に書き換えられる。顧客の追加と削除もできる。
//   貸付が残っている客は削除できない。取引の記録がある客は、削除すると台帳から外すだけで記録は残す。
(function (root) {
  'use strict';

  // 金額はすべて円（整数）。台帳CSVの金額は万円で書かれているので、読み込み時に円へ直す。
  const CONFIG = {
    days: 365,                // 既定の期間：11/1〜翌年10/31の1年。最終日は締め日（15日か月末）に限る
    maxDays: 365 * 5,         // 延ばせる上限
    startDate: '2026-11-01',  // 1日目の日付
    startCash: 1000000,
    goalPerDay: 13700,        // 標準の目標の純利 = 1日あたり13,700円 × 日数（1年で500万円、45日で60万円）
    minCycle: 1,              // S の範囲
    maxCycle: 30,
    minRate: 10,              // 1Sあたりの利息の範囲（千分率。10 = 元金の1%、1000 = 100%）
    maxRate: 1000,
    maxFeeRatio: 0.2,         // 振込手数料（元金 − 振込金額）の上限。元金の2割まで
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
    fuwatariDays: 14,         // 期日からこの日数以上遅れて連絡がつかない客を、締めで不渡りにする
    raidPolice: 50,           // 警察の手入れが起きはじめる警察の目
    raidChance: 0.25,
    fine: 150000,
    rivalCost: 50000,
    windfallScale: 3,         // 大当たりのときの隠し資産の倍率
    windfallFlat: 200000,     // 隠し資産がないときの大当たり額
    collectFullJump: false,   // true なら取り立て成功で未払いジャンプ金を必ず満額回収する（false：かき集めた額だけ。足りなければ延滞のまま）
    unknownChance: 0.07,      // 1日のうちに不明入金が入る確率（貸付があるとき）
    unknownMin: 5000,
    unknownMax: 30000,
    revealMin: 2,             // 不明入金の持ち主がわかるまでの日数
    revealMax: 5,
  };

  // 条件の呼び名（トイチなど）。表示の補足に使う。rate は千分率（元金に対する1回の利息）。
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
    lend: { label: '貸付', cash: -1 },                           // お金が出ていくのは振込金額（transfer）
    fee: { label: '振込手数料（売上）', cash: 0 },              // 元金から天引きした分。貸した日に売上に計上
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
    flee: { label: '夜逃げ（連絡不通）', cash: 0 },
    fuwatari: { label: '不渡り', cash: 0 },                     // 締めで元金を貸付総元金から引いた記録
  };

  // 経費の種類
  const COSTS = {
    investigate: '身辺調査費',
    fine: '罰金',
    rival: 'チラシ代（ライバル対策）',
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
  // 開始の年と違う年の日付には年を付ける（期間が年をまたぐので）
  function fmtDay(day) {
    const t = dateOf(day);
    const y = t.getUTCFullYear() === Number(CONFIG.startDate.slice(0, 4)) ? '' : `${t.getUTCFullYear()}/`;
    return `${y}${t.getUTCMonth() + 1}/${t.getUTCDate()}(${WEEK[t.getUTCDay()]})`;
  }
  const dateNumOf = (day) => dateOf(day).getUTCDate();
  const isoOf = (day) => dateOf(day).toISOString().slice(0, 10);   // 2026-11-10（日付の入力欄用）
  function dayOfIso(iso) {
    const [y, m, d] = String(iso).split('-').map(Number);
    if (!y || !m || !d) return NaN;
    return Math.round((Date.UTC(y, m - 1, d) - dateOf(1)) / 86400000) + 1;
  }
  // その日が開始月から何か月目か（0 = 開始月）
  function monthOffsetOfDay(day) {
    const t = dateOf(day), [y, m] = CONFIG.startDate.split('-').map(Number);
    return (t.getUTCFullYear() - y) * 12 + (t.getUTCMonth() + 1 - m);
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
  const horizonDay = (s) => { const n = monthInfo(monthOffsetOfDay(s.days) + 1); return n.firstDay + n.daysInMonth - 1; }; // 最終日の翌月末

  function fmtDayLong(day) {
    const t = dateOf(day);
    return `${t.getUTCFullYear()}年${t.getUTCMonth() + 1}月${t.getUTCDate()}日（${WEEK[t.getUTCDay()]}）`;
  }

  // 締め日（毎月15日と月末）。この日の終わりに不渡りを計上する
  function closingOf(day) {
    const t = dateOf(day), next = dateOf(day + 1);
    if (next.getUTCDate() === 1) return '月末';
    return t.getUTCDate() === 15 ? '15日' : null;
  }
  function nextClosingDay(day) {
    let d = day;
    while (!closingOf(d)) d++;
    return d;
  }
  // from〜to の締め日の一覧（期間の最終日の候補）
  function closingDays(from, to) {
    const list = [];
    for (let d = nextClosingDay(from); d <= to; d = nextClosingDay(d + 1)) list.push(d);
    return list;
  }

  // ---- 貸付条件 ----

  const stepOf = (cycle) => Math.max(1, cycle - 1);                  // 期日の間隔（当日から換算）
  // ジャンプ金 = 元金残高 × 利息/元金（①の比率。円未満切り捨て）
  const jumpOf = (loan, principal) => Math.floor(((principal === undefined ? loan.principal : principal) * loan.interest0) / loan.lent);
  const per10 = (rate, cycle) => (rate / 1000) * 10 / cycle;   // 10日あたりに直した利率（ジャンプ金は S 日分）
  const aprOf = (rate, cycle) => (rate / 1000) * 365 / cycle;  // 年利換算（単利・S 日分として）
  const pctText = (rate) => (Math.abs(rate % 100) < 1e-9 ? `${Math.round(rate / 100)}割` : `${Math.round(rate) / 10}%`);
  const termsDesc = (rate, cycle) => `${cycle}Sで${pctText(rate)}`;
  function termsLabel(rate, cycle) {
    const preset = Object.values(PRESETS).find((p) => Math.abs(p.rate - rate) < 1e-9 && p.cycle === cycle);
    return preset ? preset.label : termsDesc(rate, cycle);
  }

  // 万円の表記（50000 → "5"、23500 → "2.35"）
  const manOf = (n) => String(Math.round(n) / 10000);
  const notationOf = (principal, payoff) => `${manOf(principal)}-${manOf(payoff)}`;
  // ①「元金-完済金」（万円）を読む。全角や「ー」「〜」も受け付ける
  function parseNotation(text) {
    const t = String(text || '').normalize('NFKC').replace(/[\s万円]/g, '').replace(/[ー－−‐–—〜~]/g, '-');
    const m = t.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/);
    if (!m) throw new GameError('①は「元金-完済金」を万円で書いてください（例：5-6.5 は元金50,000円・完済金65,000円）');
    const [a, b] = [Number(m[1]) * 10000, Number(m[2]) * 10000];
    if (Math.abs(a - Math.round(a)) > 1e-6 || Math.abs(b - Math.round(b)) > 1e-6) throw new GameError('①の金額は1円単位まで（万円で小数4桁まで）にしてください');
    return { principal: Math.round(a), payoff: Math.round(b) };
  }
  const policeOf = (rate, cycle) => Math.max(0, Math.round(35 * per10(rate, cycle) - 5.5));
  function rateNige(rate, cycle) {
    const x = Math.max(0, per10(rate, cycle) - 0.1);
    return Math.min(0.5, 1.25 * x * x);
  }
  // 受付の5項目を確かめて、貸付条件にまとめる。
  //   input = { notation: '5-6.5', cycle: 10, firstDue: 10（ゲーム内の日）, transfer: 45000, account: '…' }
  function checkTerms(s, input) {
    const c = visitorOf(s);
    if (!c) throw new GameError('来店中の客がいません');
    const { principal, payoff } = parseNotation(input.notation);
    const cycle = Number(input.cycle);
    if (!(principal >= CONFIG.minLend && principal % CONFIG.lendUnit === 0)) {
      throw new GameError(`①の元金は${yen(CONFIG.minLend)}以上、${yen(CONFIG.lendUnit)}単位にしてください（万円で小数1桁まで）`);
    }
    const interest = payoff - principal;
    if (interest <= 0) throw new GameError('①の完済金は元金より多くしてください（例：5-6.5）');
    const rate = (1000 * interest) / principal;
    if (rate < CONFIG.minRate || rate > CONFIG.maxRate) {
      throw new GameError(`利息（完済金−元金）は元金の${CONFIG.minRate / 10}%〜${CONFIG.maxRate / 10}%にしてください（今は${pctText(rate)}）`);
    }
    if (!(Number.isInteger(cycle) && cycle >= CONFIG.minCycle && cycle <= CONFIG.maxCycle)) {
      throw new GameError(`②のSは${CONFIG.minCycle}〜${CONFIG.maxCycle}で決めてください`);
    }
    const firstDue = Number(input.firstDue);
    if (!(Number.isInteger(firstDue) && firstDue > s.day && firstDue <= s.days)) {
      throw new GameError(`③初回の期日は${fmtDay(s.day + 1)}〜${fmtDay(s.days)}（最終日）の間で選んでください`);
    }
    const transfer = Number(input.transfer);
    if (!(Number.isInteger(transfer) && transfer >= 1 && transfer <= principal)) {
      throw new GameError(`④振込金額は1円〜元金（${yen(principal)}）の間にしてください`);
    }
    const fee = principal - transfer;
    const maxFee = Math.floor(principal * CONFIG.maxFeeRatio);
    if (fee > maxFee) throw new GameError(`手数料（元金−振込金額）は元金の${CONFIG.maxFeeRatio * 10}割（${yen(maxFee)}）までです`);
    const want = s.people[c.id].want;
    if (transfer > want) throw new GameError(`④振込金額は希望額（${yen(want)}）までです`);
    if (transfer > s.cash) throw new GameError(`手持ち資金が足りません（振込金額 ${yen(transfer)}・手持ち ${yen(s.cash)}）`);
    const account = String(input.account || '').trim().slice(0, 100);
    return { principal, payoff, interest, rate, cycle, firstDue, transfer, fee, account, notation: notationOf(principal, payoff) };
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
      return normalizeCustomer(c);
    });
  }

  // ---- 顧客カルテ（編集できる項目） ----

  const SOURCES = ['X', 'DM', 'テレアポ', '紹介', 'チラシ', '飛び込み', 'ネット検索', 'その他'];   // 流入元
  const WEAK_TYPES = ['情', '見栄', '家族'];
  const EMERGENCY_ROWS = 3;   // 緊急連絡先の人数
  const txt = (label, max, required) => ({ label, kind: 'text', max, required: !!required });
  const num = (label, kind, min, max) => ({ label, kind, min, max });
  // 表の情報（申告・連絡先など）。kind: text（文字）/ yen（円）/ int（整数）/ select
  const PROFILE = {
    name: txt('氏名', 30, true), kana: txt('ふりがな', 40), age: num('年齢', 'int', 18, 120), job: txt('職業', 40),
    address: txt('現住所', 120), homeAddress: txt('実家の住所', 120), homeContact: txt('実家の連絡先', 60),
    declaredIncome: num('月収（申告）', 'yen', 0, 100000000), want: num('希望額', 'yen', 10000, 100000000),
    claimReason: txt('申告した理由', 60), collateral: txt('担保', 60),
    workName: txt('勤務先名', 60), workPhone: txt('勤務先の電話番号', 40), workAddress: txt('勤務先の所在地', 120),
    workHours: txt('勤務時間', 40), workHoliday: txt('休日', 40), payday: txt('給料日', 40),
    guarantor: txt('保証人の氏名', 40), guarantorRelation: txt('保証人の関係', 30), guarantorContact: txt('保証人の連絡先', 60),
    source: { label: '流入元', kind: 'select', options: ['', ...SOURCES] }, referrer: txt('紹介者名', 40), sourceNote: txt('流入元の補足', 80),
  };
  const EMERGENCY = { name: txt('緊急連絡先の氏名', 40), relation: txt('緊急連絡先の関係', 30), contact: txt('緊急連絡先の連絡先', 60) };
  // ゲームの設定（身辺調査で分かる本当の情報）
  const SECRET = {
    income: num('本当の月収', 'yen', 0, 100000000), realReason: txt('本当の理由', 60),
    weakType: { label: '弱みタイプ', kind: 'select', options: WEAK_TYPES }, weak: txt('弱み', 60), weakLine: txt('弱みを突かれた時の台詞', 120),
    nige: num('逃げ足', 'int', 1, 5), uso: num('ウソつき度', 'int', 1, 5),
    hidden: txt('隠し資産', 60), hiddenAmount: num('隠し資産額', 'yen', 0, 100000000), kuchiguse: txt('口癖', 60),
  };

  // 前の版のデータや台帳CSVの客に、新しい項目をそろえる（保証人「なし」は空欄にする）
  function normalizeCustomer(c) {
    if (c.guarantor === 'なし') c.guarantor = '';
    for (const [k, spec] of Object.entries(PROFILE)) {
      if (c[k] === undefined) c[k] = spec.kind === 'text' || spec.kind === 'select' ? '' : 0;
    }
    if (!Array.isArray(c.emergency)) c.emergency = [];
    while (c.emergency.length < EMERGENCY_ROWS) c.emergency.push({ name: '', relation: '', contact: '' });
    if (c.deleted === undefined) c.deleted = false;
    return c;
  }

  function readField(spec, raw) {
    if (spec.kind === 'text') {
      const v = String(raw == null ? '' : raw).trim();
      if (spec.required && !v) throw new GameError(`${spec.label}を入れてください`);
      if (v.length > spec.max) throw new GameError(`${spec.label}は${spec.max}文字までです`);
      return v;
    }
    if (spec.kind === 'select') {
      const v = String(raw == null ? '' : raw);
      if (!spec.options.includes(v)) throw new GameError(`${spec.label}を選んでください`);
      return v;
    }
    const t = String(raw == null ? '' : raw).normalize('NFKC').replace(/[,円\s]/g, '');
    const n = Number(t);
    const show = (x) => (spec.kind === 'yen' ? yen(x) : x);
    if (t === '' || !Number.isInteger(n) || n < spec.min || n > spec.max) {
      throw new GameError(`${spec.label}は${show(spec.min)}〜${show(spec.max)}の整数で入れてください`);
    }
    return n;
  }

  // 入力を確かめて、カルテの中身にまとめる。withSecret なら本当の情報（ゲームの設定）も読む
  function readCustomer(data, withSecret) {
    const out = {};
    for (const [k, spec] of Object.entries(PROFILE)) out[k] = readField(spec, data[k]);
    out.emergency = [];
    for (let i = 0; i < EMERGENCY_ROWS; i++) {
      const row = (data.emergency && data.emergency[i]) || {};
      out.emergency.push({ name: readField(EMERGENCY.name, row.name), relation: readField(EMERGENCY.relation, row.relation), contact: readField(EMERGENCY.contact, row.contact) });
    }
    if (withSecret) for (const [k, spec] of Object.entries(SECRET)) out[k] = readField(spec, data[k]);
    return out;
  }

  // 流入元の表記：紹介（紹介者：○○）・補足
  function sourceText(c) {
    if (!c.source) return '';
    const who = c.source === '紹介' && c.referrer ? `（紹介者：${c.referrer}）` : '';
    return `${c.source}${who}${c.sourceNote ? `・${c.sourceNote}` : ''}`;
  }

  // 追加した客の本当の情報を「おまかせ」で決める（身辺調査するまで分からない）
  const AUTO = {
    reasons: ['パチンコの負けの穴埋め', 'ほかの金融への返済', '推し活の遠征費', '彼女へのプレゼント', '申告どおり（めずらしく本当）', '自己啓発セミナーの受講料'],
    weak: {
      情: ['実家の母の話をされると泣く', '飼い猫の写真を見せられると弱い'],
      見栄: ['会社に借金がバレること', 'SNSのフォロワーに知られること'],
      家族: ['妻に内緒で借りている', '子どもの運動会が近い'],
    },
    line: {
      情: '…それを言われたら、返すしかないやないですか…',
      見栄: 'ちょっ、声大きいです！ 職場の人に聞こえる！',
      家族: '家族にだけは言わんといてください！',
    },
    hidden: ['へそくり', '使っていない金のネックレス', '解約していない積立保険', '押し入れのレトロゲーム'],
    kuchiguse: ['なんとかなるっしょ', '来月には入るんで', 'ほんま助かります', '一時的なもんなんで'],
  };
  function randomSecret(s, v) {
    const ratio = 0.5 + 0.5 * rand(s);   // 本当の月収は申告の5〜10割
    const weakType = pick(s, WEAK_TYPES);
    const hasHidden = rand(s) < 0.5;
    return {
      income: floorTo(v.declaredIncome * ratio, 1000),
      uso: Math.min(5, Math.max(1, 1 + Math.round((1 / ratio - 1) / 0.25))),
      realReason: pick(s, AUTO.reasons), weakType, weak: pick(s, AUTO.weak[weakType]), weakLine: AUTO.line[weakType],
      nige: 1 + Math.floor(rand(s) * 5),
      hidden: hasHidden ? pick(s, AUTO.hidden) : 'なし', hiddenAmount: hasHidden ? (5 + Math.floor(rand(s) * 26)) * 10000 : 0,
      kuchiguse: pick(s, AUTO.kuchiguse),
    };
  }

  // ---- 状態 ----

  function newGame(customers, seed) {
    const s = {
      v: 8, day: 0, days: CONFIG.days, goal: goalFor(CONFIG.days),
      cash: CONFIG.startCash, sugomi: 1, police: 0, seed: seed >>> 0, unknowns: [], nextUnknownId: 1,
      costs: [], closings: [],
      customers, people: {}, loans: [], txs: [], visitor: null, nightUsed: false, log: [], over: null,
      nextLoanId: 1, nextTxId: 1, nextCustomerNo: 1 + Math.max(0, ...customers.map((c) => Number(c.id) || 0)),
    };
    customers.forEach(normalizeCustomer);
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
  const onBooks = (loan) => isActive(loan) || loan.status === '夜逃げ';   // 貸付総元金に入っている貸付（夜逃げは不渡りの計上まで残る）
  const lateDaysOf = (s, loan, day) => (loan.lateSince == null ? 0 : (day || s.day) - loan.lateSince); // 期日から何日遅れているか
  // 夜逃げした貸付を不渡りに計上する締め日（期日から2週間を過ぎた最初の締め）
  const fuwatariDayOf = (s, loan) => nextClosingDay(Math.max(s.day, loan.lateSince + CONFIG.fuwatariDays));
  const hasGuarantor = (s, c) => !!c.guarantor && c.guarantor !== 'なし' && !s.people[c.id].guarantorGone;
  const log = (s, kind, text) => s.log.push({ day: s.day, kind, text });
  const owedOf = (loan) => loan.principal + loan.accrued;
  const nextJumpOf = (loan) => jumpOf(loan);

  // 期日にかき集められる額（1,000円単位）
  function capOf(s, c, cycle) {
    return floorTo(c.income * CONFIG.capRatio * (cycle / 10) * (0.8 + 0.4 * rand(s)), CONFIG.payUnit);
  }

  // 期日ごとにかき集められる額の目安（画面の判断材料）
  function capRange(c, cycle, real) {
    const base = (real ? c.income : c.declaredIncome) * CONFIG.capRatio * (cycle / 10);
    return [floorTo(base * 0.8, CONFIG.payUnit), floorTo(base * 1.2, CONFIG.payUnit)];
  }

  function spend(s, kind, amount) {
    if (amount <= 0) return 0;
    s.cash -= amount;
    s.costs.push({ day: s.day, kind, amount });
    return amount;
  }

  function tx(s, loan, type, amount, parts) {
    s.txs.push({
      id: s.nextTxId++, day: s.day, loanId: loan.id, customerId: loan.customerId, type, amount,
      toInterest: (parts && parts.toInterest) || 0, toPrincipal: (parts && parts.toPrincipal) || 0,
      principal: loan.principal, accrued: loan.accrued,
      ...(type === 'lend' ? { transfer: parts.transfer, fee: parts.fee } : {}),
    });
  }
  // 取引で手持ち資金がいくら動いたか（貸付は振込金額だけ出ていく）
  const cashOf = (t) => (t.type === 'lend' ? -t.transfer : TX[t.type].cash * t.amount);

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
    const waiting = s.customers.filter((c) => !c.deleted && !s.people[c.id].refused && s.people[c.id].nextVisit === s.day);
    waiting.slice(1).forEach((c) => s.people[c.id].nextVisit++);
    if (waiting.length) arrive(s, waiting[0]);
  }

  function arrive(s, c) {
    const p = s.people[c.id];
    p.nextVisit = null;
    p.refused = false;
    p.visits++;
    s.visitor = c.id;
    const again = p.visits > 1 ? 'また' : '';
    log(s, 'visit', `${c.name}が${again}来店。「${c.claimReason || 'ちょっと物入りで'}で、${yen(p.want)}貸してください…」`);
  }

  // 不明入金：誰からかわからない入金が入る。数日後、持ち主から電話があって判明する。
  const unknownLeft = (u) => u.amount - u.allocated - u.refunded;

  function unknownEvents(s) {
    for (const u of s.unknowns) {
      if (u.revealed || u.revealDay !== s.day || unknownLeft(u) <= 0) continue;
      u.revealed = true;
      const c = customerOf(s, u.ownerId) || { name: '持ち主' };
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
      status: loan.status, due: loan.due, overdueDays: loan.overdueDays, lateSince: loan.lateSince, closedDay: loan.closedDay, jumps: loan.jumps,
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
      // 未払いのジャンプ金を満額払えたのでジャンプ成立。次回の期日は元の予定のまま（払った日から数え直さない）
      loan.status = '返済中';
      loan.overdueDays = 0;
      loan.lateSince = null;
      loan.jumps++;
      text += `ジャンプ金が満額そろってジャンプ成立。次回の期日は元の予定どおり${fmtDay(loan.due)}。`;
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
    if (loan.status === '夜逃げ' || loan.status === '不渡り') return { ok: false, reason: `${loan.status}になった貸付の充当は取り消せません` };
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
    loan.jumps = a.before.jumps;
    loan.lateSince = a.before.lateSince;
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
      // 初回は貸した日から初回の期日まで（当日から数えて）の日数分、2回目からは S 日分かき集めてくる
      const cap = capOf(s, c, loan.due === loan.firstDue ? loan.firstDue - loan.lentDay + 1 : loan.cycle);
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
      loan.lateSince = s.day;           // 遅れはじめた期日（不渡りの判定に使う）
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
    spend(s, 'investigate', CONFIG.investigateCost);
    p.investigated = true;
    log(s, 'info', `身辺調査に${yen(CONFIG.investigateCost)}。${c.name}の本当の借金理由は「${c.realReason}」だった。`);
  }

  // 振込できる上限（希望額と手持ち資金の少ないほう）
  function lendLimit(s) {
    const c = visitorOf(s);
    return c ? Math.max(0, Math.min(s.people[c.id].want, s.cash)) : 0;
  }

  // 貸す前の見積もり（画面のプレビュー用）。ジャンプし続けた場合の見込み。
  function quote(s, input) {
    const t = checkTerms(s, input);
    const step = stepOf(t.cycle);
    let dues = 0;
    for (let d = t.firstDue; d <= s.days; d += step) dues++;
    return {
      ...t, due: t.firstDue, nextDue: t.firstDue + step, step, dues, expected: t.interest * dues,
      firstSpan: t.firstDue - s.day + 1,   // 初回の期日までの日数（当日から数えて）
      per10: per10(t.rate, t.cycle), apr: aprOf(t.rate, t.cycle), police: policeOf(t.rate, t.cycle), nige: rateNige(t.rate, t.cycle),
    };
  }

  // 受付表記の1行。①5-6.5 ②10S ③初回11/10 ④振込金額45,000円 ⑤振込先口座
  const receiptOf = (l) => `①${notationOf(l.lent, l.payoff0)} ②${l.cycle}S ③初回${fmtDay(l.firstDue)} ④振込金額${yen(l.transfer)} ⑤${l.account || '振込先口座は未入力'}`;

  function lend(s, input) {
    const c = visitorOf(s);
    const t = checkTerms(s, input);
    s.cash -= t.transfer;
    s.police += policeOf(t.rate, t.cycle);
    const loan = {
      id: s.nextLoanId++, customerId: c.id, lent: t.principal, principal: t.principal, accrued: 0,
      interest0: t.interest, payoff0: t.payoff, rate: t.rate, cycle: t.cycle,
      lentDay: s.day, firstDue: t.firstDue, due: t.firstDue, transfer: t.transfer, fee: t.fee, account: t.account,
      status: '返済中', overdueDays: 0, lateSince: null, jumps: 0,
      collected: 0, interestPaid: 0, closedDay: null, fuwatari: 0, fuwatariDay: null,
    };
    s.loans.push(loan);
    tx(s, loan, 'lend', t.principal, { transfer: t.transfer, fee: t.fee });
    if (t.fee) tx(s, loan, 'fee', t.fee);
    s.people[c.id].account = t.account;   // 次に来たときの振込先の初期値
    s.visitor = null;
    log(s, 'minus', `${c.name}に貸付。${receiptOf(loan)}。完済金額${yen(t.payoff)}、初回のジャンプ金${yen(t.interest)}。${t.fee ? `手数料${yen(t.fee)}は振込手数料として売上に計上。` : ''}`);
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
      // 取り立てに成功すると、その時かき集められるだけ払ってくる（collectFullJump なら未払いジャンプ金は満額そろえてくる）
      const grab = capOf(s, c, loan.cycle);
      let total = pay(s, loan, CONFIG.collectFullJump ? Math.max(grab, loan.accrued) : grab, 'collect');
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
      } else if (loan.accrued === 0) {
        // ジャンプ金が満額そろったのでジャンプ成立。次回の期日は元の予定のまま（回収した日から数え直さない）
        loan.status = '返済中';
        loan.overdueDays = 0;
        loan.lateSince = null;
        loan.jumps++;
        log(s, 'plus', `${yen(total)}を回収。未払いジャンプ金が満額そろってジャンプ成立。残りの元金は${yen(loan.principal)}、次回の期日は元の予定どおり${fmtDay(loan.due)}。`);
      } else {
        // 満額に届かなければ、ジャンプは成立せず延滞のまま
        log(s, 'bad', `${yen(total)}を回収。でも未払いジャンプ金があと${yen(loan.accrued)}足りず、ジャンプは成立しない。延滞のまま。`);
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

  // ---- 顧客カルテの編集・追加・削除 ----

  // 来店予定日を入れられるか（day = null は未定）
  function checkVisit(s, c, day) {
    if (day === null) return;
    if (!(Number.isInteger(day) && day >= s.day && day <= s.days)) {
      throw new GameError(`来店予定日は${fmtDay(s.day)}（今日）〜${fmtDay(s.days)}（最終日）の間で選んでください`);
    }
    if (c.deleted) throw new GameError('台帳から外した客は来店しません。先に元に戻してください');
    if (day === s.day && s.visitor !== c.id) {
      if (s.over) throw new GameError('勝負はもう終わっています');
      if (s.visitor) throw new GameError('今日はほかの客の受付中です。来店予定は明日以降にしてください');
    }
  }

  // 次の来店予定を決める。今日にすると（ほかに来店中の客がいなければ）すぐ来店する
  function setVisit(s, c, day) {
    checkVisit(s, c, day);
    const p = s.people[c.id];
    if (day === null) p.nextVisit = null;
    else if (day === s.day) { if (s.visitor !== c.id) arrive(s, c); }
    else {
      p.nextVisit = day;
      p.refused = false;   // 断った客でも、来店予定を入れれば来る
    }
  }

  // カルテを書き換える。data は PROFILE・SECRET の各項目、emergency（3名分）、guarantorGone、nextVisit（日 / null / 省略で変えない）
  function updateCustomer(s, id, data) {
    const c = customerOf(s, id);
    if (!c) throw new GameError('その客は台帳にいません');
    const v = readCustomer(data, true);
    const p = s.people[id];
    const visitChanged = data.nextVisit !== undefined && data.nextVisit !== p.nextVisit;
    if (visitChanged) checkVisit(s, c, data.nextVisit);   // まちがいがあれば、何も書き換えずに止める
    Object.assign(c, v);
    p.want = v.want;
    if (typeof data.guarantorGone === 'boolean') p.guarantorGone = data.guarantorGone;
    log(s, 'info', `${c.name}（No.${c.id}）の顧客カルテを更新した。`);
    if (visitChanged) setVisit(s, c, data.nextVisit);
    return c;
  }

  // 顧客を追加する。data.auto が true なら本当の情報（ゲームの設定）はおまかせ。来店予定の初期値は明日
  function addCustomer(s, data) {
    const v = readCustomer(data, !data.auto);
    if (data.auto) Object.assign(v, randomSecret(s, v));
    const id = String(s.nextCustomerNo).padStart(3, '0');
    const c = normalizeCustomer({ id, ...v });
    const visit = data.nextVisit === undefined ? Math.min(s.day + 1, s.days) : data.nextVisit;
    if (!s.over) checkVisit(s, c, visit);
    s.nextCustomerNo++;
    s.customers.push(c);
    s.people[id] = {
      nextVisit: null, want: c.want, investigated: false, hiddenUsed: false,
      guarantorGone: false, refused: false, visits: 0, memo: '',
    };
    log(s, 'info', `顧客台帳に${c.name}（No.${id}）を追加した。${c.source ? `流入元：${sourceText(c)}。` : ''}`);
    if (!s.over) setVisit(s, c, visit);
    return c;
  }

  // 削除できるか。貸付が残っている客と来店中の客は削除できない
  function canDeleteCustomer(s, id) {
    const c = customerOf(s, id);
    if (!c) return { ok: false, reason: 'その客は台帳にいません' };
    if (c.deleted) return { ok: false, reason: 'もう台帳から外してあります' };
    if (s.visitor === id) return { ok: false, reason: '来店中の客は削除できません。先に貸すか断ってください' };
    const loans = s.loans.filter((l) => l.customerId === id);
    if (loans.some(onBooks)) return { ok: false, reason: '貸付が残っているので削除できません（完済か不渡りのあとに削除できます）' };
    return { ok: true, reason: '', keepsRecord: loans.length > 0 };
  }

  // 削除する。取引の記録がない客は台帳から消し、記録がある客は台帳から外すだけにする（元金表や履歴の数字を残すため）
  function deleteCustomer(s, id) {
    const check = canDeleteCustomer(s, id);
    if (!check.ok) throw new GameError(check.reason);
    const c = customerOf(s, id);
    if (!check.keepsRecord) {
      s.customers = s.customers.filter((x) => x.id !== id);
      delete s.people[id];
      log(s, 'info', `顧客台帳から${c.name}（No.${id}）を削除した。`);
      return 'removed';
    }
    c.deleted = true;
    s.people[id].nextVisit = null;
    log(s, 'info', `${c.name}（No.${id}）を顧客台帳から外した（取引の記録は残す）。`);
    return 'archived';
  }

  function restoreCustomer(s, id) {
    const c = customerOf(s, id);
    if (!c || !c.deleted) throw new GameError('元に戻せる客ではありません');
    c.deleted = false;
    log(s, 'info', `${c.name}（No.${id}）を顧客台帳に戻した。`);
  }

  // 「最初から」で引き継ぐ顧客台帳（台帳から外した客は除く）
  const rosterOf = (s) => JSON.parse(JSON.stringify(s.customers.filter((c) => !c.deleted)));

  // 前の版の保存データを今の形にそろえる
  function migrate(s) {
    s.customers.forEach(normalizeCustomer);
    if (s.nextCustomerNo == null) s.nextCustomerNo = 1 + Math.max(0, ...s.customers.map((c) => Number(c.id) || 0));
    s.v = 8;
    return s;
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
        // 夜逃げした客には連絡がつかない。元金は不渡りに計上するまで貸付総元金に残る
        tx(s, loan, 'flee', 0);
        close(s, loan, '夜逃げ');
        log(s, 'bad', `${c.name}が夜逃げした。部屋には「${c.kuchiguse}」と書かれた置き手紙だけ。電話もつながらない。元金${yen(loan.principal)}は${fmtDay(fuwatariDayOf(s, loan))}の締めで不渡りに計上する。`);
      }
    }

    townEvent(s);
    s.police = Math.max(0, s.police - CONFIG.policeDecay);
    if (closingOf(s.day)) closeBooks(s);

    const active = s.loans.some(isActive);
    if (s.cash < CONFIG.minLend && !active) s.over = { win: false, reason: '貸す金も、取り立てる相手もいない。どてらい金融、倒産。' };
    else if (s.police >= 100) s.over = { win: false, reason: '警察の目が限界を超えた。ガサ入れで店じまい。' };
    else if (s.day >= s.days) {
      const net = pl(s).net;
      const span = `${fmtDay(1)}〜${fmtDay(s.days)}（${s.days}日）`;
      s.over = net >= s.goal
        ? { win: true, byTime: true, reason: `${span}で純利${yen(net)}。目標の${yen(s.goal)}を超えた！` }
        : { win: false, byTime: true, reason: `${span}で純利${yen(net)}。目標の${yen(s.goal)}に届かなかった。` };
    }
    if (s.over) log(s, s.over.win ? 'plus' : 'bad', s.over.reason);
    else startDay(s);
  }

  // 今日の予定（早送りが止まる理由）：来店・期日（入金や延滞の結果が出た日）・締め日・延滞中の客
  const DUE_TX = ['accrue', 'lateAccrue', 'jump', 'jumpPlus', 'payoff', 'partial', 'overdue'];
  function agendaOf(s) {
    const list = [];
    if (s.visitor) list.push('来店');
    if (s.txs.some((t) => t.day === s.day && DUE_TX.includes(t.type))) list.push('期日');
    if (closingOf(s.day)) list.push('締め');
    if (s.loans.some((l) => l.status === '延滞')) list.push('延滞');
    return list;
  }

  // 早送り：予定のない日は続けて終えて、次に予定がある日で止まる（延滞客がいる間は毎日止まる）。
  // 締めは15日と月末に必ずあるので、長くても半月ほどで止まる。
  function skipToNext(s) {
    if (s.over) throw new GameError('勝負はもう終わっています');
    if (s.visitor) throw new GameError('来店した客への返事がまだです');
    const from = s.day;
    do endDay(s); while (!s.over && !agendaOf(s).length);
    return { from, to: s.day, days: s.day - from, agenda: s.over ? [] : agendaOf(s) };
  }

  // 期間の標準の目標（1日あたりの目安 × 日数、10万円単位）
  const goalFor = (days) => Math.max(100000, Math.round((CONFIG.goalPerDay * days) / 100000) * 100000);

  // 期間（最終日）と目標の純利を変える。最終日は締め日に限る（最後の締めで不渡りを計上してから判定するため）。
  // 期間が終わって結果が出たあとでも、延ばせば営業を続けられる。
  function setPeriod(s, endDay, goal) {
    if (!(Number.isInteger(endDay) && closingOf(endDay))) throw new GameError('最終日は15日か月末を選んでください');
    if (endDay > CONFIG.maxDays) throw new GameError(`最終日は${fmtDay(CONFIG.maxDays)}までにしてください`);
    const extending = s.over && s.over.byTime;
    if (s.over && !extending) throw new GameError('店じまいしたので、期間は変えられません');
    if (endDay < s.day || (extending && endDay <= s.day)) throw new GameError('最終日は今日より後にしてください');
    if (!(Number.isInteger(goal) && goal >= 1)) throw new GameError('目標の純利は1円以上で決めてください');
    const before = s.days;
    s.days = endDay;
    s.goal = goal;
    log(s, 'info', `期間を${fmtDayLong(endDay)}まで（${endDay}日）、目標の純利を${yen(goal)}にした（前の最終日は${fmtDay(before)}）。`);
    if (extending) {
      s.over = null;
      log(s, 'info', '期間を延ばして、営業を続ける。');
      startDay(s);
    }
  }

  // 締め（15日・月末）。期日から2週間以上遅れて連絡がつかない（夜逃げした）客を不渡りにし、元金を貸付総元金から引く
  function closeBooks(s) {
    const booked = [];
    for (const loan of s.loans) {
      if (loan.status !== '夜逃げ' || lateDaysOf(s, loan) < CONFIG.fuwatariDays) continue;
      loan.status = '不渡り';
      loan.fuwatari = loan.principal;
      loan.fuwatariDay = s.day;
      tx(s, loan, 'fuwatari', loan.fuwatari);
      booked.push(loan.id);
    }
    const p = pl(s);
    const amount = booked.reduce((a, id) => a + loanOf(s, id).fuwatari, 0);
    const waiting = s.loans.filter((l) => l.status === '夜逃げ');
    s.closings.push({ day: s.day, kind: closingOf(s.day), loanIds: booked, amount, sales: p.sales, expenses: p.expenses, fuwatari: p.fuwatari, net: p.net });
    let text = `【${fmtDay(s.day)}・${closingOf(s.day)}の締め】`;
    text += booked.length
      ? `不渡り${booked.length}件（${booked.map((id) => customerOf(s, loanOf(s, id).customerId).name).join('・')}）、元金${yen(amount)}を貸付総元金から引いた。`
      : '不渡りはなし。';
    if (waiting.length) text += `夜逃げしてまだ2週間たっていない${waiting.length}件（元金${yen(waiting.reduce((a, l) => a + l.principal, 0))}）は次の締めに持ち越し。`;
    text += `ここまでの純利${yen(p.net)}（総売上${yen(p.sales)} − 経費${yen(p.expenses)} − 不渡り${yen(p.fuwatari)}）。`;
    log(s, booked.length ? 'bad' : 'info', text);
  }

  function townEvent(s) {
    if (s.police >= CONFIG.raidPolice && rand(s) < CONFIG.raidChance) {
      const fine = spend(s, 'fine', Math.min(CONFIG.fine, s.cash));
      s.police = Math.max(0, s.police - 30);
      log(s, 'bad', `警察の手入れ。帳簿を突っつかれて罰金${yen(fine)}。`);
      return;
    }
    const r = rand(s);
    const active = s.loans.filter(isActive);
    if (r < 0.05) {
      const cost = spend(s, 'rival', Math.min(CONFIG.rivalCost, s.cash));
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

  // 期日前・延滞中の返済（大当たりなど）。期日は元の予定の並びのまま動かさない。
  //   期日前にジャンプ金以上を持ってきた → 次の期日の分のジャンプを先に済ませた扱い。今回分のジャンプ金を取り、
  //                                       残りで元金を詰める（全部返せば完済金額＝元金＋ジャンプ金）。次回の期日はその次の予定日。
  //   期日前でジャンプ金に満たない       → まだジャンプ金は発生していないので、全額で元金を詰める（期日はそのまま）。
  //   延滞中                             → 未払いジャンプ金に先に充て、満額そろえばジャンプ成立。次回の期日は元の予定どおり。
  function earlyPay(s, loan, amount) {
    const earlyJump = loan.status === '返済中' && amount >= nextJumpOf(loan);
    if (earlyJump) accrue(s, loan, 'earlyAccrue');
    const got = pay(s, loan, amount, 'windfall');
    if (loan.status === '完済') return got;
    if (earlyJump) { loan.due += stepOf(loan.cycle); loan.jumps++; }   // 次の期日の分は払い済み
    else if (loan.status === '延滞' && loan.accrued === 0) {
      loan.status = '返済中';
      loan.overdueDays = 0;
      loan.lateSince = null;
      loan.jumps++;
    }
    return got;
  }

  // ---- 集計（台帳・カレンダー・元金表で使う） ----

  // 損益。純利 = 総売上（回収したジャンプ金＋振込手数料）− 経費 − 不渡り（締めで計上した元金）
  function pl(s) {
    const jumpSales = s.loans.reduce((a, l) => a + l.interestPaid, 0);
    const feeSales = s.loans.reduce((a, l) => a + l.fee, 0);
    const sales = jumpSales + feeSales;
    const expenses = s.costs.reduce((a, c) => a + c.amount, 0);
    const fuwatari = s.loans.reduce((a, l) => a + l.fuwatari, 0);
    const byKind = {};
    for (const c of s.costs) byKind[c.kind] = (byKind[c.kind] || 0) + c.amount;
    return { sales, jumpSales, feeSales, expenses, fuwatari, net: sales - expenses - fuwatari, byKind };
  }

  // 次の締めで不渡りになる見込みの貸付（夜逃げして、締めの日に期日から2週間以上たっているもの）
  function fuwatariPlan(s) {
    const day = nextClosingDay(s.closings.some((c) => c.day === s.day) ? s.day + 1 : s.day);   // 今日の締めが済んでいたら次の締め
    const due = [], later = [];
    for (const l of s.loans.filter((x) => x.status === '夜逃げ')) {
      (lateDaysOf(s, l, day) >= CONFIG.fuwatariDays ? due : later).push(l);
    }
    return { day, due, later };
  }

  function totals(s) {
    const t = { lent: 0, balance: 0, accrued: 0, interestPaid: 0, principalBack: 0, collected: 0, active: 0, overdue: 0, jumps: 0, unknownHeld: 0, unknownOpen: 0, fled: 0, fledCount: 0, fuwatari: 0, fuwatariCount: 0 };
    for (const u of s.unknowns) {
      t.unknownHeld += unknownLeft(u);
      if (unknownLeft(u) > 0) t.unknownOpen++;
    }
    for (const l of s.loans) {
      t.lent += l.lent;
      t.interestPaid += l.interestPaid;
      t.collected += l.collected;
      t.jumps += l.jumps;
      t.principalBack += l.lent - l.principal;   // 回収累計 = ジャンプ金累計 + 回収済元金
      if (onBooks(l)) t.balance += l.principal;   // 貸付総元金（夜逃げも不渡りに計上するまで入る）
      if (isActive(l)) { t.accrued += l.accrued; t.active++; }
      if (l.status === '延滞') t.overdue++;
      if (l.status === '夜逃げ') { t.fled += l.principal; t.fledCount++; }
      if (l.status === '不渡り') { t.fuwatari += l.fuwatari; t.fuwatariCount++; }
    }
    return t;
  }

  // これからの期日（ジャンプし続けた場合の見込み）。日付 → 予定の配列。horizon までの日を出す
  function schedule(s, horizon) {
    const last = horizon || s.days;
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
      if (c.deleted) status = '削除済み';
      const active = loans.filter(isActive);
      const dues = active.filter((l) => l.status === '返済中').map((l) => l.due);
      return {
        c, p, loans, loan, status,
        balance: loans.filter(onBooks).reduce((a, l) => a + l.principal, 0),
        fuwatari: loans.reduce((a, l) => a + l.fuwatari, 0),
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
    investigate, lend, lendLimit, quote, refuse, collect, setMemo, endDay, skipToNext, agendaOf,
    PROFILE, SECRET, EMERGENCY_ROWS, SOURCES, WEAK_TYPES, sourceText, updateCustomer, addCustomer,
    canDeleteCustomer, deleteCustomer, restoreCustomer, rosterOf, migrate,
    COSTS, pl, fuwatariPlan, closingOf, nextClosingDay, lateDaysOf, fuwatariDayOf, onBooks,
    totals, schedule, ledger, nigeChance, capRange, owedOf, nextJumpOf, isActive,
    visitorOf, customerOf, loanOf, hasGuarantor,
    fmtDay, fmtDayLong, weekdayOf, termsLabel, termsDesc, pctText, per10, aprOf, policeOf, rateNige,
    stepOf, jumpOf, yen, monthInfo, horizonDay, allocateUnknown, unknownOf, unknownLeft,
    parseNotation, notationOf, manOf, receiptOf, cashOf, setPeriod, goalFor, closingDays,
    dateNumOf, isoOf, dayOfIso, monthOffsetOfDay,
    canCancelAllocation, cancelAllocation, refundUnknown,
    _settleDue: settleDue,   // 検証用：期日の入金額を指定して処理する
    _earlyPay: earlyPay,     // 検証用：期日前の返済を処理する
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Game = api;
})(this);
