// どてらい金融 顧客管理システム — 画面の描画と操作。計算は logic.js（window.Game）に任せる。
(function () {
  'use strict';
  const G = window.Game;
  const $ = (sel) => document.querySelector(sel);
  const SAVE_KEY = 'dotera-kinyu:v7';

  let s = null;
  let mark = 0;                 // 業務日誌で「今日の分」として見せるログの開始位置
  const ui = {
    view: 'today',
    calDay: null,               // カレンダーで選んでいる日（null なら今日）
    calMonth: 0,                // カレンダーの月（-1 = 前月、0 = 開始月、1 = 翌月）
    alloc: null,                // 充当画面 { id, loanId, amount }
    calCustomer: '',            // カレンダーの顧客絞り込み
    drawer: null,               // { kind: 'customer' | 'loan', id }
    cust: { q: '', status: 'すべて', sort: 'id' },
    loans: { status: 'すべて', sort: 'id' },
    resultClosed: false,        // 結果を閉じて帳簿を見返しているとき
    period: null,               // 期間・目標の画面 { end, goal }
    skip: null,                 // 直前の早送り { from, to, days, agenda }
  };
  // 受付の入力欄 ①notation ②cycle ③firstDue ④transfer ⑤account。初回と振込金額は、手で変えるまで①②に合わせて動かす
  let form = { visitor: null };

  // ---- 表示の小道具 ----

  const esc = (t) => String(t).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const num = (n) => Math.round(n).toLocaleString('ja-JP');
  const yen = (n) => `${num(n)}円`;
  const pct = (x) => `${(Math.round(x * 1000) / 10).toLocaleString('ja-JP', { maximumFractionDigits: 1 })}%`;
  const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
  const badge = (status) => `<span class="badge st-${esc(status)}">${esc(status)}</span>`;
  const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
  const rowAttrs = (act, id) => `data-act="${act}" data-id="${esc(id)}" tabindex="0" role="button"`;
  const custLink = (c) => `<button class="link" data-act="open-customer" data-id="${esc(c.id)}">${esc(c.name)}</button>`;
  const loanLink = (loan) => `<button class="link" data-act="open-loan" data-id="${loan.id}">No.${loan.id}</button>`;
  const dayLink = (d) => (d > G.horizonDay(s) || d < 1 ? `<span class="muted">${G.fmtDay(d)}</span>` : `<button class="link" data-act="goto-day" data-day="${d}">${G.fmtDay(d)}</button>`);
  // 条件の表記：①5-6.5 ②10S。下に「3割・トサン」のような補足
  const rateNote = (l) => {
    const label = G.termsLabel(l.rate, l.cycle);
    return `1回${G.pctText(l.rate)}${label === G.termsDesc(l.rate, l.cycle) ? '' : `・${label}`}`;
  };
  const notationText = (l) => `${G.notationOf(l.lent, l.payoff0)}・${l.cycle}S`;
  const termsCell = (l) => `<b>${esc(notationText(l))}</b><span class="sub">${esc(rateNote(l))}</span>`;
  const txSign = (t) => Math.sign(G.cashOf(t));
  const signed = (n) => (n < 0 ? `−${num(-n)}` : num(n));
  const signedYen = (n) => `${signed(n)}円`;
  const lastDay = () => G.fmtDay(s.days);   // 最終日
  // 取引の内訳。例：ジャンプ(80,000)＋元金詰め(149,000)
  function breakdown(t, principalWord) {
    const parts = [];
    if (t.toInterest) parts.push(`ジャンプ(${signed(t.toInterest)})`);
    if (t.toPrincipal) parts.push(`${principalWord || '元金詰め'}(${signed(t.toPrincipal)})`);
    return parts.join('＋') || '—';
  }
  const collectedLine = (jump, prin) => `<p class="breakdown">回収累計 <b>${yen(jump + prin)}</b> ＝ ジャンプ金累計 <b class="in">${yen(jump)}</b> ＋ 回収済元金 <b>${yen(prin)}</b></p>`;
  // 純利 ＝ 総売上 − 経費 − 不渡り
  const plLine = (p) => `<p class="breakdown pl">純利 <b class="${p.net < 0 ? 'out' : 'in'}">${signedYen(p.net)}</b> ＝ 総売上 <b>${yen(p.sales)}</b>${p.feeSales ? `<small>（ジャンプ金 ${num(p.jumpSales)}＋振込手数料 ${num(p.feeSales)}）</small>` : ''} − 経費 <b>${yen(p.expenses)}</b> − 不渡り <b class="${p.fuwatari ? 'out' : ''}">${yen(p.fuwatari)}</b></p>`;
  function txSummary(t) {
    switch (t.type) {
      case 'lend': return `貸付：元金(${num(t.amount)})・振込(${num(t.transfer)})`;
      case 'fee': return `振込手数料(${num(t.amount)})：元金から天引きして売上に計上`;
      case 'accrue': case 'lateAccrue': case 'earlyAccrue': return `${G.TX[t.type].label}(${num(t.amount)})`;
      case 'overdue': return `延滞（未払いジャンプ金 ${num(t.accrued)}）`;
      case 'flee': return `夜逃げ・連絡不通（元金 ${num(t.principal)}・未払いジャンプ金 ${num(t.accrued)}）`;
      case 'fuwatari': return `不渡り：元金(${num(t.amount)})を貸付総元金から引く`;
      case 'jump': case 'jumpPlus': return breakdown(t);
      case 'payoff': return `完済：${breakdown(t, '元金')}`;
      case 'partial': return `一部入金：ジャンプ(${num(t.toInterest)})のみ・ジャンプ未達`;
      case 'allocCancel': return `充当の取消：${breakdown(t, '元金')}`;
      default: return `${G.TX[t.type].label}：${breakdown(t)}`;
    }
  }
  const txAmount = (t) => {
    const k = txSign(t);
    if (t.type === 'overdue' || t.type === 'flee') return '<span class="muted">—</span>';
    if (t.type === 'fuwatari') return `<span class="bad">${num(t.amount)}</span>`;
    if (t.type === 'fee') return `<span class="in" title="お金は動かない（振込金額を減らした分）">売上 ${num(t.amount)}</span>`;
    if (k > 0) return `<span class="in">+${num(t.amount)}</span>`;
    if (k < 0) return `<span class="out">−${num(-G.cashOf(t))}</span>`;
    return `<span class="muted">${signed(t.amount)}</span>`;   // 充当・取消・ジャンプ金発生（お金は動かない）
  };

  // ---- 保存（ブラウザに自動保存。読めなくてもゲームは動く） ----

  function save() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify({ s, mark })); } catch (e) { /* 保存できない環境では何もしない */ }
  }
  function loadSave() {
    try {
      const d = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
      if (!d || !d.s || !(d.s.v === 7 || d.s.v === 8)) return null;
      G.migrate(d.s);   // 前の版の保存データに、カルテの新しい項目をそろえる
      return d;
    } catch (e) { return null; }
  }
  function clearSave() {
    try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* 同上 */ }
  }

  // ---- 起動 ----

  async function boot() {
    const d = loadSave();
    if (d) {
      s = d.s;
      mark = d.mark || 0;
      render();
      toast('前回の続きから再開しました');
      return;
    }
    const list = await fetchCustomers();
    if (list) start(list);
  }

  async function fetchCustomers() {
    try {
      const res = await fetch('customers.csv', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return G.loadCustomers(await res.text());
    } catch (e) {
      $('#loader').hidden = false;
      $('#loader-error').textContent = e instanceof G.GameError ? e.message : '';
      return null;
    }
  }

  $('#csv-file').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      start(G.loadCustomers(await file.text()));
      $('#loader').hidden = true;
    } catch (e) {
      $('#loader-error').textContent = e.message;
    }
  });

  function start(list) {
    s = G.newGame(list, (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0);
    mark = 0;
    Object.assign(ui, { view: 'today', calDay: null, calMonth: 0, calCustomer: '', drawer: null, alloc: null, resultClosed: false, reset: false, skip: null });
    form.visitor = null;
    $('#result').hidden = true;
    save();
    render();
    window.scrollTo(0, 0);
  }

  // 最初から。fromCsv なら customers.csv を読み直し、そうでなければ今の顧客台帳（編集・追加した客）を引き継ぐ
  async function restart(fromCsv) {
    const roster = s ? G.rosterOf(s) : [];
    const list = fromCsv || !roster.length ? await fetchCustomers() : roster;
    if (!list) return;
    clearSave();
    start(list);
    toast(fromCsv || !roster.length ? 'customers.csv を読み直して、1日目から始めました' : `今の顧客台帳（${list.length}名）で、1日目から始めました`);
  }

  // ---- 操作 ----

  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }

  function act(fn) {
    try { fn(); }
    catch (e) { if (e instanceof G.GameError) toast(e.message); else throw e; }
    save();
    render();
  }

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el || el.disabled || !s) return;
    const a = el.dataset.act;
    if (a === 'tab') { ui.view = el.dataset.view; ui.drawer = null; render(); window.scrollTo(0, 0); }
    else if (a === 'investigate') act(() => G.investigate(s));
    else if (a === 'refuse') act(() => G.refuse(s));
    else if (a === 'collect') act(() => G.collect(s, Number(el.dataset.loan), el.dataset.cmd));
    else if (a === 'step') {
      form.cycle = Math.min(G.CONFIG.maxCycle, Math.max(G.CONFIG.minCycle, (form.cycle || 0) + Number(el.dataset.d)));
      syncTermInputs();
    } else if (a === 'period-open') {
      if (s.over && !s.over.byTime) { toast('店じまいしたので、期間は変えられません'); return; }
      ui.period = { end: s.days, goal: s.goal };
      ui.resultClosed = true;
      $('#result').hidden = true;
      renderPeriod();
    }
    else if (a === 'period-close') { ui.period = null; renderPeriod(); renderResult(); }
    else if (a === 'period-std') { ui.period.goal = G.goalFor(ui.period.end); renderPeriod(); }
    else if (a === 'end') {
      if (s.over) { ui.resultClosed = false; renderResult(); return; }
      act(() => { const before = s.log.length; G.endDay(s); mark = before; ui.skip = null; ui.calDay = null; ui.calMonth = G.monthOffsetOfDay(s.day); });
      if (!s.over) window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (a === 'skip') {
      let r = null;
      act(() => { const before = s.log.length; r = G.skipToNext(s); mark = before; ui.skip = r; ui.calDay = null; ui.calMonth = G.monthOffsetOfDay(s.day); });
      if (r) toast(s.over ? `${r.days}日進めて、勝負の結果が出ました` : `${r.days}日進めて${G.fmtDay(r.to)}へ（${r.agenda.join('・')}）`);
      if (!s.over) window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (a === 'open-customer') { ui.drawer = { kind: 'customer', id: el.dataset.id }; renderDrawer(true); }
    else if (a === 'open-loan') { ui.drawer = { kind: 'loan', id: Number(el.dataset.id) }; renderDrawer(true); }
    else if (a === 'close-drawer') {
      if (ui.drawer && ui.drawer.edit && !window.confirm('編集中の内容は保存されません。閉じますか？')) return;
      ui.drawer = null;
      renderDrawer();
    }
    else if (a === 'goto-day') {
      const d = Number(el.dataset.day);
      Object.assign(ui, { view: 'calendar', calDay: d, calMonth: monthOffsetOf(d), drawer: null });
      render();
      window.scrollTo(0, 0);
    }
    else if (a === 'cal-month') { const m = months(); ui.calMonth = Math.max(m[0], Math.min(m[m.length - 1], Number(el.dataset.offset))); renderView(); }
    else if (a === 'alloc-open') { ui.alloc = { id: Number(el.dataset.id), loanId: null, amount: null }; renderAlloc(); }
    else if (a === 'alloc-close') { ui.alloc = null; renderAlloc(); }
    else if (a === 'alloc-cancel') {
      const id = Number(el.dataset.id), idx = Number(el.dataset.idx);
      const chk = G.canCancelAllocation(s, id, idx);
      if (!chk.ok) { toast(chk.reason); return; }
      const al = G.unknownOf(s, id).allocations[idx], loan = G.loanOf(s, al.loanId);
      if (window.confirm(`${G.fmtDay(al.day)}の充当（${G.customerOf(s, loan.customerId).name} No.${loan.id} へ${yen(al.amount)}）を取り消します。\n元金とジャンプ金は充当前に戻り、${yen(al.amount)}は不明入金（未充当）に戻ります。よろしいですか？`)) {
        act(() => G.cancelAllocation(s, id, idx));
      }
    } else if (a === 'refund') {
      const u = G.unknownOf(s, Number(el.dataset.id));
      if (window.confirm(`${G.fmtDay(u.day)}の不明入金のうち、未充当の${yen(G.unknownLeft(u))}を返金（組戻し）します。\n手持ち資金から出ていき、取り消せません。よろしいですか？`)) {
        act(() => { G.refundUnknown(s, u.id); ui.alloc = null; });
      }
    }
    else if (a === 'cal-day') { ui.calDay = Number(el.dataset.day); renderView(); }
    else if (a === 'filter') { ui[el.dataset.scope].status = el.dataset.value; renderView(); }
    else if (a === 'restart' || a === 'reset') { ui.reset = true; renderReset(); }
    else if (a === 'reset-roster' || a === 'reset-csv') { ui.reset = false; renderReset(); restart(a === 'reset-csv'); }
    else if (a === 'reset-close') { ui.reset = false; renderReset(); }
    else if (a === 'cust-new') { ui.drawer = { kind: 'customer', id: null, edit: true }; renderDrawer(true); }
    else if (a === 'cust-edit') { ui.drawer = { kind: 'customer', id: el.dataset.id, edit: true }; renderDrawer(true); }
    else if (a === 'cust-cancel') { ui.drawer = ui.drawer.id ? { kind: 'customer', id: ui.drawer.id } : null; renderDrawer(true); }
    else if (a === 'cust-delete') {
      const id = el.dataset.id, chk = G.canDeleteCustomer(s, id);
      if (!chk.ok) { toast(chk.reason); return; }
      const c = G.customerOf(s, id);
      const msg = chk.keepsRecord
        ? `${c.name}（No.${id}）を顧客台帳から外します。\n取引の記録（元金表・カレンダー・損益）は残り、あとで元に戻せます。よろしいですか？`
        : `${c.name}（No.${id}）を顧客台帳から削除します。\nカルテの内容は消え、元に戻せません。よろしいですか？`;
      if (window.confirm(msg)) act(() => { const r = G.deleteCustomer(s, id); ui.drawer = r === 'archived' ? { kind: 'customer', id } : null; });
    } else if (a === 'cust-restore') act(() => G.restoreCustomer(s, el.dataset.id));
  });

  // 行や日付マスをキーボードでも開けるようにする
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && ui.alloc) { ui.alloc = null; renderAlloc(); return; }
    if (ev.key === 'Escape' && ui.period) { ui.period = null; renderPeriod(); renderResult(); return; }
    if (ev.key === 'Escape' && ui.reset) { ui.reset = false; renderReset(); return; }
    if (ev.key === 'Escape' && ui.drawer && !ui.drawer.edit) { ui.drawer = null; renderDrawer(); return; }   // 編集中は「やめる」で閉じる
    const el = ev.target;
    if ((ev.key === 'Enter' || ev.key === ' ') && el.getAttribute && el.getAttribute('role') === 'button' && el.tagName !== 'BUTTON') {
      ev.preventDefault();
      el.click();
    }
  });

  document.addEventListener('submit', (ev) => {
    if (ev.target.id === 'alloc-form') {
      ev.preventDefault();
      const u = G.unknownOf(s, ui.alloc.id);
      const amount = ui.alloc.amount == null ? G.unknownLeft(u) : ui.alloc.amount;
      act(() => { G.allocateUnknown(s, ui.alloc.id, ui.alloc.loanId, amount); ui.alloc = null; });
      return;
    }
    if (ev.target.id === 'cust-form') {
      ev.preventDefault();
      saveCustomerForm(ev.target);
      return;
    }
    if (ev.target.id === 'period-form') {
      ev.preventDefault();
      act(() => { G.setPeriod(s, ui.period.end, ui.period.goal); ui.period = null; ui.resultClosed = false; });
      return;
    }
    if (ev.target.id !== 'terms') return;
    ev.preventDefault();
    act(() => G.lend(s, form));
  });

  let memoTimer = null;
  document.addEventListener('input', (ev) => {
    const t = ev.target;
    if (t.name === 'notation') { form.notation = t.value; followTerms(); updateQuote(); }
    else if (t.name === 'cycle') { form.cycle = Number(t.value); followTerms(); updateQuote(); }
    else if (t.name === 'firstDue') { form.firstDue = G.dayOfIso(t.value); form.firstTouched = true; updateQuote(); }
    else if (t.name === 'transfer') { form.transfer = t.value === '' ? NaN : Number(t.value); form.transferTouched = true; updateQuote(); }
    else if (t.name === 'account') { form.account = t.value; updateQuote(); }
    else if (t.id === 'period-goal') { ui.period.goal = t.value === '' ? NaN : Number(t.value); }
    else if (t.id === 'cust-q') { ui.cust.q = t.value; renderCustomerTable(); }
    else if (t.id === 'alloc-amount') { ui.alloc.amount = t.value === '' ? NaN : Math.floor(Number(t.value)); updateAllocPreview(); }
    else if (t.id === 'memo') {
      G.setMemo(s, t.dataset.id, t.value);
      $('#memo-state').textContent = '保存中…';
      clearTimeout(memoTimer);
      memoTimer = setTimeout(() => { save(); const m = $('#memo-state'); if (m) m.textContent = '保存しました'; }, 400);
    }
  });

  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.id === 'cust-sort') { ui.cust.sort = t.value; renderCustomerTable(); }
    else if (t.id === 'loan-sort') { ui.loans.sort = t.value; renderView(); }
    else if (t.id === 'cal-customer') { ui.calCustomer = t.value; renderView(); }
    else if (t.id === 'alloc-loan') { ui.alloc.loanId = t.value ? Number(t.value) : ''; updateAllocPreview(); }
    else if (t.id === 'cal-month-select') { ui.calMonth = Number(t.value); renderView(); }
    else if (t.name === 'auto' && t.form && t.form.id === 'cust-form') { $('#secret-fields').hidden = t.checked; }
    else if (t.name === 'source' && t.form && t.form.id === 'cust-form') { $('#cf-referrer').closest('.field').classList.toggle('dim', t.value !== '紹介'); }
    else if (t.id === 'period-end') {
      // 目標を標準のまま触っていなければ、新しい期間の標準に合わせる
      const wasStd = ui.period.goal === G.goalFor(ui.period.end);
      ui.period.end = Number(t.value);
      if (wasStd) ui.period.goal = G.goalFor(ui.period.end);
      renderPeriod();
    }
  });

  // ---- 全体の描画 ----

  function render() {
    if (!s) return;
    renderKpis();
    renderTabs();
    renderView();
    renderDrawer();
    renderFooter();
    renderResult();
    renderAlloc();
    renderPeriod();
    renderReset();
  }

  function renderKpis() {
    const t = G.totals(s);
    const p = G.pl(s);
    const goal = s.goal;
    const plan = G.fuwatariPlan(s);
    const police = Math.min(100, s.police);
    $('#period-label').textContent = `${G.fmtDay(1)}〜${G.fmtDay(s.days)}（${s.days}日）`;
    $('#kpis').innerHTML = `
      <div><dt>営業日</dt><dd>${G.fmtDay(s.day)}<small>${s.day}/${s.days}日目</small></dd></div>
      <div><dt>手持ち資金</dt><dd>${yen(s.cash)}</dd></div>
      <div><dt>貸付総元金</dt><dd>${yen(t.balance)}<small>${t.active + t.fledCount}件</small></dd></div>
      <div><dt>次の締め</dt><dd>${G.fmtDay(plan.day)}<small>${plan.due.length ? `不渡り見込み${plan.due.length}件` : G.closingOf(plan.day)}</small></dd></div>
      <div class="wide"><dt>純利 / 目標</dt><dd class="${p.net < 0 ? 'neg' : ''}">${signedYen(p.net)}<small>/ ${yen(goal)}</small></dd>
        <div class="meter goal"><i style="width:${Math.max(0, Math.min(100, (p.net / goal) * 100))}%"></i></div></div>
      <div><dt>凄み</dt><dd class="sugomi" title="取り立ての成功率が上がり、夜逃げされにくくなる">${stars(s.sugomi)}</dd></div>
      <div><dt>警察の目</dt><dd>${police}<small>/ 100</small></dd>
        <div class="meter police ${police >= G.CONFIG.raidPolice ? 'hot' : ''}"><i style="width:${police}%"></i></div></div>`;
  }

  function renderTabs() {
    const overdue = s.loans.filter((l) => l.status === '延滞').length;
    const sched = G.schedule(s);
    let soon = 0;
    for (let d = s.day + 1; d <= Math.min(s.days, s.day + 7); d++) soon += (sched[d] || []).length;
    const active = s.loans.filter(G.isActive).length;
    const tabs = [
      ['today', '本日の業務', s.visitor ? '来店あり' : overdue && !s.nightUsed ? `取り立て${overdue}` : '', s.visitor ? 'hot' : ''],
      ['customers', '顧客台帳', overdue ? `延滞${overdue}` : '', overdue ? 'hot' : ''],
      ['calendar', 'カレンダー', soon ? `7日以内${soon}件` : '', ''],
      ['loans', '元金表', G.totals(s).unknownOpen ? `不明入金${G.totals(s).unknownOpen}` : active ? `${active}件` : '', G.totals(s).unknownOpen ? 'hot' : ''],
    ];
    $('#tabs').innerHTML = tabs.map(([key, label, note, cls]) => `
      <button class="tab ${ui.view === key ? 'on' : ''}" data-act="tab" data-view="${key}" ${ui.view === key ? 'aria-current="page"' : ''}>
        ${label}${note ? `<span class="tab-note ${cls}">${esc(note)}</span>` : ''}</button>`).join('');
  }

  function renderView() {
    const v = $('#view');
    if (ui.view === 'customers') { v.innerHTML = viewCustomers(); renderCustomerTable(); }
    else if (ui.view === 'calendar') v.innerHTML = viewCalendar();
    else if (ui.view === 'loans') v.innerHTML = viewLoans();
    else { v.innerHTML = viewToday(); updateQuote(); }
  }

  function renderFooter() {
    const btn = $('#end');
    const overdue = s.loans.some((l) => l.status === '延滞');
    btn.disabled = !!s.visitor;
    const skip = $('#skip');
    skip.disabled = !!s.visitor || !!s.over || s.day >= s.days;
    skip.title = overdue ? '延滞客がいる間は、早送りしても1日ずつ進みます' : '予定（来店・期日・締め・延滞）のない日を飛ばして、次に予定がある日まで進めます';
    btn.textContent = s.over ? '結果をもう一度見る' : s.day >= s.days ? '勝負の結果を見る ▶' : '1日を終える ▶';
    let hint = `${G.fmtDayLong(s.day)}`;
    if (s.visitor) hint = '来店した客に、貸すか断るかを決めてください（本日の業務）';
    else if (overdue && !s.nightUsed) hint = '延滞客がいます。取り立てずに終えることもできます（延滞客がいる間は、早送りも1日ずつ）';
    if (!s.visitor && !s.over && G.closingOf(s.day)) hint = `今日は${G.closingOf(s.day)}の締め日。1日を終えると、期日から2週間以上遅れて連絡がつかない客を不渡りにします`;
    $('#hint').textContent = hint;
  }

  // ---- 本日の業務 ----

  function viewToday() {
    const todayTx = s.txs.filter((t) => t.day === s.day);
    const todayUnk = sum(s.unknowns.filter((u) => u.day === s.day), (u) => u.amount);
    const inflow = sum(todayTx.filter((t) => txSign(t) > 0), (t) => t.amount) + todayUnk;
    const outflow = sum(todayTx.filter((t) => txSign(t) < 0), (t) => -G.cashOf(t));   // 貸付は振込金額
    const dueToday = todayTx.filter((t) => ['jump', 'jumpPlus', 'payoff', 'overdue'].includes(t.type)).length;
    const overdue = s.loans.filter((l) => l.status === '延滞').length;
    const today = s.log.slice(mark);
    const history = s.log.slice(0, mark).reverse();
    const logItems = (list, withDay) => list.map((e) =>
      `<li class="${e.kind}">${withDay ? `<span class="day">${G.fmtDay(e.day)}</span>` : ''}${esc(e.text)}</li>`).join('');
    // 早送りしたときは、飛ばした日の出来事も日付つきで並べ、その間の入金をまとめて見せる
    const skipped = ui.skip && ui.skip.to === s.day && ui.skip.days > 1 ? ui.skip : null;
    const multiDay = !!skipped || new Set(today.map((e) => e.day)).size > 1;
    const journalSub = s.day === 1 ? '開店初日' : skipped ? `早送り：${G.fmtDay(skipped.from)}の夜〜${G.fmtDay(s.day)}（${skipped.days}日分）` : multiDay ? '前回からの出来事' : '昨夜から今日まで';
    let skipNote = '';
    if (skipped) {
      const span = s.txs.filter((t) => t.day > skipped.from && t.day <= s.day && txSign(t) > 0);
      const unk = sum(s.unknowns.filter((u) => u.day > skipped.from && u.day <= s.day), (u) => u.amount);
      skipNote = `<p class="help lead">早送りした${skipped.days}日の入金は計${yen(sum(span, (t) => t.amount) + unk)}（ジャンプ金 ${num(sum(span, (t) => t.toInterest))}・元金 ${num(sum(span, (t) => t.toPrincipal))}${unk ? `・不明入金 ${num(unk)}` : ''}）。止まった理由：${esc(skipped.agenda.join('・'))}</p>`;
    }
    return `
      <div class="stat-row">
        <div class="stat"><span>本日の入金</span><b class="in">${yen(inflow)}</b>
          ${inflow ? `<em>ジャンプ ${num(sum(todayTx.filter((t) => txSign(t) > 0), (t) => t.toInterest))}＋元金 ${num(sum(todayTx.filter((t) => txSign(t) > 0), (t) => t.toPrincipal))}${todayUnk ? `＋不明 ${num(todayUnk)}` : ''}</em>` : ''}</div>
        <div class="stat"><span>本日の貸付</span><b class="out">${yen(outflow)}</b></div>
        <div class="stat"><span>本日期日の客</span><b>${dueToday}件</b></div>
        <div class="stat"><span>延滞中</span><b class="${overdue ? 'bad' : ''}">${overdue}件</b></div>
      </div>
      ${plLine(G.pl(s))}
      ${fuwatariNoticeHtml()}
      ${pendingHtml()}
      <div class="cols">
        <div class="col">
          <section class="panel">
            <header class="panel-h"><h2>受付</h2><span class="sub">${G.fmtDayLong(s.day)}</span></header>
            ${visitorHtml()}
          </section>
          <section class="panel">
            <header class="panel-h"><h2>今夜の取り立て</h2><span class="sub">一晩に1回だけ</span></header>
            ${nightHtml()}
          </section>
        </div>
        <div class="col">
          <section class="panel">
            <header class="panel-h"><h2>業務日誌</h2><span class="sub">${journalSub}</span></header>
            ${skipNote}
            <ul class="log">${today.length ? logItems(today, multiDay) : '<li class="info">静かな一日。何も起きていない。</li>'}</ul>
            <details class="history"><summary>これまでの日誌（${history.length}件）</summary>
              <ul class="log small">${logItems(history, true) || '<li class="info">まだ記録はありません。</li>'}</ul></details>
          </section>
          <section class="panel">
            <header class="panel-h"><h2>今後7日の支払い予定</h2><button class="link" data-act="tab" data-view="calendar">カレンダーで見る</button></header>
            ${upcomingHtml()}
          </section>
        </div>
      </div>`;
  }

  function pendingHtml() {
    const open = s.unknowns.filter((u) => G.unknownLeft(u) > 0);
    if (!open.length) return '';
    const known = open.filter((u) => u.revealed);
    return `<section class="panel notice">
      <header class="panel-h"><h2>要対応：不明入金</h2><span class="sub">未充当 ${open.length}件・${yen(sum(open, G.unknownLeft))}${known.length ? `（うち持ち主が判明 ${known.length}件）` : ''}</span>
        <button class="link right" data-act="tab" data-view="loans">元金表で一覧を見る</button></header>
      ${unknownTableHtml(open)}
    </section>`;
  }

  // 不渡りの予定（夜逃げして連絡がつかない客）。締め日の当日も出す
  function fuwatariNoticeHtml() {
    const plan = G.fuwatariPlan(s);
    const today = G.closingOf(s.day);
    if (s.over || (!plan.due.length && !plan.later.length && !today)) return '';
    const sumP = (list) => sum(list, (l) => l.principal);
    const head = today
      ? `今日（${G.fmtDay(s.day)}）は${today}の締め日。1日を終えると締めます`
      : `次の締めは${G.fmtDay(plan.day)}（${G.closingOf(plan.day)}）`;
    return `<section class="panel notice danger">
      <header class="panel-h"><h2>不渡りの予定</h2><span class="sub">${head}</span>
        <button class="link right" data-act="tab" data-view="loans">元金表で損益を見る</button></header>
      ${plan.due.length || plan.later.length ? fuwatariTableHtml(plan) : '<p class="empty">連絡がつかない客はいません。今回の締めで不渡りになる貸付はありません。</p>'}
      <p class="help">期日から2週間以上遅れて連絡がつかない（夜逃げした）客は、15日と月末の締めで不渡りにして、元金を貸付総元金から引きます。${plan.due.length ? `今回は${plan.due.length}件・元金${yen(sumP(plan.due))}が純利から引かれます。` : ''}</p>
    </section>`;
  }

  function fuwatariTableHtml(plan) {
    const rows = [...plan.due, ...plan.later].map((l) => {
      const c = G.customerOf(s, l.customerId), now = plan.due.includes(l);
      const when = G.fuwatariDayOf(s, l);
      return `<tr><td>${custLink(c)}</td><td>${loanLink(l)}</td><td class="num"><b>${yen(l.principal)}</b></td>
        <td>${G.fmtDay(l.lateSince)}</td><td>${dayLink(l.closedDay)}</td><td class="num">${G.lateDaysOf(s, l, plan.day)}日</td>
        <td>${now ? `<span class="bad">${G.fmtDay(plan.day)}に不渡り</span>` : `<span class="muted">2週間未満・${G.fmtDay(when)}に計上予定</span>`}</td></tr>`;
    }).join('');
    return `<div class="table-wrap"><table class="data compact">
      <thead><tr><th>顧客</th><th>貸付</th><th class="num">元金</th><th>遅れた期日</th><th>夜逃げした日</th><th class="num">締め日の遅れ</th><th>扱い</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  function upcomingHtml() {
    const sched = G.schedule(s);
    const rows = [];
    for (let d = s.day + 1; d <= Math.min(s.days, s.day + 7); d++) {
      for (const e of sched[d] || []) rows.push({ d, e });
    }
    if (!rows.length) return '<p class="empty">7日以内に支払い予定の客はいません。</p>';
    return `<div class="table-wrap"><table class="data compact">
      <thead><tr><th>期日</th><th>顧客</th><th>貸付</th><th class="num">ジャンプ金</th><th class="num">完済金額</th></tr></thead>
      <tbody>${rows.map(({ d, e }) => `<tr>
        <td>${dayLink(d)}</td><td>${custLink(e.customer)}</td><td>${loanLink(e.loan)}</td>
        <td class="num">${yen(e.jump)}</td><td class="num">${yen(e.payoff)}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  function visitorHtml() {
    const c = G.visitorOf(s);
    if (!c) return `<p class="empty">${s.over ? '店じまい。' : '本日の来店客はもういません。'}</p>`;
    const p = s.people[c.id];
    const limit = G.lendLimit(s);
    const minLend = G.CONFIG.minLend, unit = G.CONFIG.lendUnit;
    if (form.visitor !== c.id) {
      const P = Math.max(minLend, Math.floor(Math.min(limit, p.want) / unit) * unit);
      form = {
        visitor: c.id, notation: G.notationOf(P, Math.round(P * 1.1)), cycle: 10,
        firstDue: Math.min(s.days, s.day + G.stepOf(10)), transfer: P, account: p.account || '',
        firstTouched: false, transferTouched: false,
      };
    }

    const income = p.investigated
      ? `<s>${yen(c.declaredIncome)}</s> → 本当は <span class="truth">${yen(c.income)}</span>`
      : `${yen(c.declaredIncome)} <small>（自己申告）</small>`;
    const secret = p.investigated
      ? `<dl class="facts">
          <dt>本当の理由</dt><dd class="truth">${esc(c.realReason)}</dd>
          <dt>弱み</dt><dd>${esc(c.weak)} <small>（${esc(c.weakType)}に弱い）</small></dd>
          <dt>逃げ足</dt><dd>${stars(c.nige)}</dd>
          <dt>ウソつき度</dt><dd>${stars(c.uso)}</dd>
          <dt>隠し資産</dt><dd>${esc(c.hidden)}</dd>
        </dl>`
      : `<div class="locked">
          <span>本当の理由・弱み・逃げ足は ？？？</span>
          <button class="ghost" data-act="investigate" ${s.cash < G.CONFIG.investigateCost ? 'disabled' : ''}>身辺調査する（${yen(G.CONFIG.investigateCost)}）</button>
        </div>`;

    const canLend = limit >= minLend * (1 - G.CONFIG.maxFeeRatio) && s.day < s.days;
    const terms = canLend
      ? `<form id="terms" class="terms" novalidate>
          <p class="help lead">受付表記の5項目を入力します（例：①5-6.5 ②10S ③初回11/10 ④振込金額45,000円 ⑤振込先口座）。</p>
          <div class="field two">
            <div>
              <label for="f-notation">① 元金-完済金（万円）</label>
              <input type="text" id="f-notation" name="notation" class="text-input" value="${esc(form.notation)}" placeholder="例：5-6.5" inputmode="decimal" autocomplete="off">
              <p class="help">5-6.5 ＝ 元金50,000円に対して完済金65,000円（利息15,000円）</p>
            </div>
            <div>
              <label for="f-cycle">② S（支払いサイクル）</label>
              <div class="stepper">
                <button type="button" data-act="step" data-d="-1" aria-label="Sを1減らす">−</button>
                <input type="number" id="f-cycle" name="cycle" min="${G.CONFIG.minCycle}" max="${G.CONFIG.maxCycle}" step="1" value="${form.cycle}">
                <span>S</span>
                <button type="button" data-act="step" data-d="1" aria-label="Sを1増やす">＋</button>
              </div>
            </div>
          </div>
          <div class="field two">
            <div>
              <label for="f-first">③ 初回の期日</label>
              <input type="date" id="f-first" name="firstDue" class="text-input" value="${Number.isInteger(form.firstDue) ? G.isoOf(form.firstDue) : ''}" min="${G.isoOf(s.day + 1)}" max="${G.isoOf(s.days)}">
              <p class="help" id="first-note"></p>
            </div>
            <div>
              <label for="f-transfer">④ 振込金額</label>
              <span class="unit-input"><input type="number" id="f-transfer" name="transfer" min="1" step="1" value="${Number.isFinite(form.transfer) ? form.transfer : ''}"><span>円</span></span>
              <p class="help">元金との差は振込手数料として売上に計上（元金の${G.CONFIG.maxFeeRatio * 10}割まで）。上限${yen(limit)}（希望額 ${yen(p.want)}・手持ち資金 ${yen(s.cash)}）</p>
            </div>
          </div>
          <div class="field">
            <label for="f-account">⑤ 振込先口座</label>
            <input type="text" id="f-account" name="account" class="text-input" maxlength="100" value="${esc(form.account)}" placeholder="例：どてら銀行 浪速支店 普通 1234567 ナニワ タロウ" autocomplete="off">
          </div>
          <div class="quote" id="quote" aria-live="polite"></div>
          <div class="actions">
            <button type="submit" class="primary">この条件で貸す</button>
            <button type="button" class="ghost" data-act="refuse">断る</button>
          </div>
        </form>`
      : `<div class="terms"><p class="empty">${s.day >= s.days
        ? `今日は最終日（${lastDay()}）なので、初回の期日を期間内に置けず、新しく貸せません。貸すなら上の「期間・目標」から期間を延ばしてください。`
        : `貸せるお金がありません（振込金額は最低${yen(minLend * (1 - G.CONFIG.maxFeeRatio))}）。`}</p>
          <div class="actions"><button class="ghost" data-act="refuse">断る</button></div></div>`;

    return `
      <article class="card">
        <header class="card-h">
          <span class="no">No.${esc(c.id)}</span>
          <h3>${esc(c.name)}<small>${esc(c.kana)}</small></h3>
          ${p.visits > 1 ? `<span class="tag">${p.visits}回目の来店</span>` : ''}
          <button class="link right" data-act="open-customer" data-id="${esc(c.id)}">顧客カルテ</button>
        </header>
        <p class="quote-line">「${esc(c.claimReason)}で、${yen(p.want)}貸してください…」</p>
        <dl class="facts">
          <dt>年齢・職業</dt><dd>${c.age}歳・${esc(c.job)}</dd>
          <dt>月収</dt><dd>${income}</dd>
          <dt>担保</dt><dd>${esc(c.collateral)}</dd>
          <dt>保証人</dt><dd>${guarantorText(c, p)}</dd>
        </dl>
        <div class="secret">${secret}</div>
        ${terms}
      </article>`;
  }

  // ③初回の期日と④振込金額は、手で変えるまで①②に合わせて動かす
  function followTerms() {
    if (!form.firstTouched && Number.isInteger(form.cycle) && form.cycle >= G.CONFIG.minCycle) {
      form.firstDue = Math.min(s.days, s.day + G.stepOf(form.cycle));
      const el = $('#f-first');
      if (el) el.value = G.isoOf(form.firstDue);
    }
    if (!form.transferTouched) {
      try {
        form.transfer = G.parseNotation(form.notation).principal;
        const el = $('#f-transfer');
        if (el) el.value = form.transfer;
      } catch (e) { if (!(e instanceof G.GameError)) throw e; /* ①が書きかけのあいだは動かさない */ }
    }
  }

  // ±ボタンでSを変えたあと、入力欄と見積もりを合わせる
  function syncTermInputs() {
    const cy = $('#f-cycle');
    if (cy) cy.value = form.cycle;
    followTerms();
    updateQuote();
  }

  function updateQuote() {
    const box = $('#quote');
    const c = s && G.visitorOf(s);
    if (!box || !c) return;
    const p = s.people[c.id];
    const note = $('#first-note');
    if (note) note.textContent = Number.isInteger(form.firstDue) && form.firstDue > s.day ? `${G.fmtDay(form.firstDue)}・今日を1日目として${form.firstDue - s.day + 1}日目` : '';
    let q;
    try { q = G.quote(s, form); }
    catch (e) {
      if (!(e instanceof G.GameError)) throw e;
      box.innerHTML = `<p class="verdict bad">${esc(e.message)}</p>`;
      return;
    }
    const [lo, hi] = G.capRange(c, q.cycle, p.investigated);
    const [flo, fhi] = G.capRange(c, q.firstSpan, p.investigated);
    let cls = 'good', verdict = '余裕あり：ジャンプ金は払えるはず。延滞しにくい条件です。';
    if (q.interest > hi) { cls = 'bad'; verdict = '払えない：ジャンプ金が返済余力を超えています。ほぼ確実に延滞します。'; }
    else if (q.interest > lo) { cls = 'warn'; verdict = 'ぎりぎり：その時の懐具合しだいでジャンプできずに延滞します。'; }
    let first = '';
    if (q.firstSpan !== q.cycle && q.interest > flo) {
      first = `<br>初回は${q.firstSpan}日分しかかき集められないので、初回の目安は${yen(flo)}〜${yen(fhi)}。${q.interest > fhi ? '初回に払えず延滞しそうです。' : '初回は懐具合しだいです。'}`;
      if (cls === 'good') cls = 'warn';
    }
    const label = G.termsLabel(q.rate, q.cycle);
    const named = label === G.termsDesc(q.rate, q.cycle) ? '' : `・${label}`;
    box.innerHTML = `
      <p class="receipt">受付表記　<b>${esc(G.receiptOf({ lent: q.principal, payoff0: q.payoff, cycle: q.cycle, firstDue: q.firstDue, transfer: q.transfer, account: q.account }))}</b></p>
      <dl class="quote-grid">
        <div><dt>元金 / 完済金</dt><dd>${yen(q.principal)}<small>完済金 ${yen(q.payoff)}（初回の期日に全部返す場合）</small></dd></div>
        <div><dt>ジャンプ金（1回）</dt><dd>${yen(q.interest)}<small>元金の${esc(G.pctText(q.rate))}${esc(named)}</small></dd></div>
        <div><dt>振込金額</dt><dd>${yen(q.transfer)}<small>手数料 ${yen(q.fee)} は売上に計上</small></dd></div>
        <div><dt>初回の期日</dt><dd>${G.fmtDay(q.due)}<small>今日を1日目として${q.firstSpan}日目</small></dd></div>
        <div><dt>ジャンプしたら次は</dt><dd>${G.fmtDay(q.nextDue)}<small>間隔は${q.step}日・利息は${q.cycle}日分</small></dd></div>
        <div><dt>最終日までのジャンプ金</dt><dd>${yen(q.expected)}<small>${lastDay()}までジャンプし続けて${q.dues}回</small></dd></div>
        <div><dt>年利換算</dt><dd>${pct(q.apr)}<small>10日あたり${pct(q.per10)}</small></dd></div>
        <div><dt>警察の目 / 夜逃げ</dt><dd>+${q.police}<small>夜逃げ率 +${pct(q.nige)}</small></dd></div>
      </dl>
      <p class="verdict ${cls}">期日ごとの返済余力の目安（${q.cycle}S）：<b>${yen(lo)}〜${yen(hi)}</b>
        <small>（${p.investigated ? '調査済み・本当の月収から' : '自己申告の月収から。ウソかもしれません'}）</small><br>${verdict}${first}</p>
      <p class="help">2回目からの期日は、初回から${q.step}日おきに並びます（遅れて払っても日付はずれません）。ジャンプ金は元金残高 × ${esc(G.pctText(q.rate))}で、入金はジャンプ金に先に充当し、多い分で元金を詰めます。</p>`;
  }

  function riskOf(loan) {
    const p = G.nigeChance(s, loan);
    if (p >= 0.3) return `<span class="risk high">夜逃げ危険度：高（${pct(p)}）</span>`;
    if (p >= 0.15) return `<span class="risk mid">夜逃げ危険度：中（${pct(p)}）</span>`;
    return `<span class="risk low">夜逃げ危険度：低（${pct(p)}）</span>`;
  }

  function nightHtml() {
    const overdue = s.loans.filter((l) => l.status === '延滞');
    if (s.over) return '<p class="empty">勝負は終わりました。</p>';
    if (!overdue.length) return '<p class="empty">延滞している客はいません。今夜はゆっくり休めます。</p>';
    if (s.nightUsed) return '<p class="empty">今夜はもう動きました。続きは明日の晩です。</p>';
    return `<p class="help lead">夜逃げされると連絡がつかなくなり、期日から2週間を過ぎた締め（15日・月末）で元金が不渡りになります。</p>` + overdue.map((loan) => {
      const c = G.customerOf(s, loan.customerId);
      const known = s.people[c.id].investigated;
      const cmds = Object.entries(G.COMMANDS).map(([k, cmd]) => {
        const off = k === 'hoshonin' && !G.hasGuarantor(s, c);
        const match = known && c.weakType === cmd.weak;
        return `<button class="cmd ${match ? 'match' : ''}" data-act="collect" data-loan="${loan.id}" data-cmd="${k}" ${off ? 'disabled' : ''}>
          ${cmd.label}<small>${off ? '保証人がいない' : `${cmd.weak}に効く・${cmd.note}`}</small></button>`;
      }).join('');
      return `<div class="debtor">
        <div class="who">${custLink(c)} ${loanLink(loan)}
          <span>元金${yen(loan.principal)}・未払いジャンプ金${yen(loan.accrued)}・延滞${loan.overdueDays}日・弱み：${known ? esc(c.weakType) : '？？？'}</span>
          <span class="sub">未払いジャンプ金を満額回収できればジャンプ成立。次回の期日は元の予定どおり${G.fmtDay(loan.due)}（足りなければ延滞のまま）</span>
          ${riskOf(loan)}</div>
        <div class="cmds">${cmds}</div>
      </div>`;
    }).join('');
  }

  // ---- 顧客台帳 ----

  const CUST_SORTS = {
    id: ['顧客番号順', (a, b) => a.c.id.localeCompare(b.c.id)],
    balance: ['貸付残高の多い順', (a, b) => b.balance - a.balance],
    due: ['次回期日の近い順', (a, b) => (a.nextDue || 999) - (b.nextDue || 999)],
    interest: ['ジャンプ金累計の多い順', (a, b) => b.interestPaid - a.interestPaid],
    principal: ['回収済元金の多い順', (a, b) => b.principalBack - a.principalBack],
  };

  function viewCustomers() {
    const rows = G.ledger(s);
    const counts = {};
    rows.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
    const order = ['来店中', '返済中', '延滞', '完済', '夜逃げ', '不渡り', 'まだ来ていない', '断った', '削除済み'];
    const live = rows.filter((r) => !r.c.deleted).length;
    const chips = [['すべて', live], ...order.filter((k) => counts[k]).map((k) => [k, counts[k]])].map(([k, n]) =>
      `<button class="filter ${ui.cust.status === k ? 'on' : ''}" data-act="filter" data-scope="cust" data-value="${k}">${k}<span>${n}</span></button>`).join('');
    const sorts = Object.entries(CUST_SORTS).map(([k, [label]]) => `<option value="${k}" ${ui.cust.sort === k ? 'selected' : ''}>${label}</option>`).join('');
    return `
      <section class="panel">
        <header class="panel-h"><h2>顧客台帳</h2><span class="sub">${live}名 ・ 行をクリックすると顧客カルテが開きます</span>
          <button class="primary small right" data-act="cust-new">＋ 顧客を追加</button></header>
        <div class="toolbar">
          <input type="search" id="cust-q" value="${esc(ui.cust.q)}" placeholder="氏名・ふりがな・職業・住所・勤務先・流入元で検索" aria-label="顧客を検索">
          <div class="filters">${chips}</div>
          <select id="cust-sort" aria-label="並び順">${sorts}</select>
        </div>
        <div id="cust-table"></div>
      </section>`;
  }

  function renderCustomerTable() {
    const box = $('#cust-table');
    if (!box) return;
    const q = ui.cust.q.trim();
    let rows = G.ledger(s);
    if (ui.cust.status === 'すべて') rows = rows.filter((r) => !r.c.deleted);   // 台帳から外した客は「削除済み」で見る
    else rows = rows.filter((r) => r.status === ui.cust.status);
    if (q) rows = rows.filter((r) => [r.c.name, r.c.kana, r.c.job, r.c.id, r.c.address, r.c.workName, G.sourceText(r.c)].some((f) => String(f || '').includes(q)));
    rows.sort(CUST_SORTS[ui.cust.sort][1]);
    if (!rows.length) { box.innerHTML = '<p class="empty">条件に合う顧客はいません。</p>'; return; }
    box.innerHTML = `<div class="table-wrap"><table class="data">
      <thead><tr><th>No</th><th>氏名</th><th>職業</th><th>流入元</th><th>状態</th><th class="num">貸付総元金</th><th class="num">未払いジャンプ金</th>
        <th>次回期日</th><th>条件</th><th class="num">ジャンプ</th><th class="num">ジャンプ金累計</th><th class="num">回収済元金</th><th>調査</th></tr></thead>
      <tbody>${rows.map((r) => {
        const live = r.loans.filter(G.isActive);
        const terms = live.length ? live.map((l) => esc(notationText(l))).join('<br>') : '—';
        return `<tr class="clickable" ${rowAttrs('open-customer', r.c.id)}>
          <td>${esc(r.c.id)}</td>
          <td><b>${esc(r.c.name)}</b><span class="sub">${esc(r.c.kana)}</span></td>
          <td>${esc(r.c.job)}</td>
          <td>${r.c.source ? esc(r.c.source) : '<span class="muted">—</span>'}${r.c.source === '紹介' && r.c.referrer ? `<span class="sub">${esc(r.c.referrer)}</span>` : ''}</td>
          <td>${badge(r.status)}</td>
          <td class="num">${r.balance ? yen(r.balance) : '—'}</td>
          <td class="num">${r.accrued ? yen(r.accrued) : '—'}</td>
          <td>${r.nextDue ? G.fmtDay(r.nextDue) : r.status === '延滞' ? '<span class="bad">延滞中</span>' : r.status === '夜逃げ' ? '<span class="bad">連絡不通</span>' : '—'}</td>
          <td>${terms}</td>
          <td class="num">${r.jumps ? `${r.jumps}回` : '—'}</td>
          <td class="num">${r.interestPaid ? yen(r.interestPaid) : '—'}</td>
          <td class="num">${r.principalBack ? yen(r.principalBack) : '—'}</td>
          <td>${r.p.investigated ? `<span class="ok">済</span><span class="sub">${esc(r.c.weakType)}・逃げ足${r.c.nige}</span>` : '<span class="muted">未</span>'}</td>
        </tr>`;
      }).join('')}</tbody></table></div>`;
  }

  // ---- カレンダー ----

  // カレンダーで見られる月：開店前の月〜最終日の翌月（-1 = 開店前の月、0 = 開始月）
  function months() {
    const list = [];
    for (let off = -1; off <= G.monthOffsetOfDay(s.days) + 1; off++) list.push(off);
    return list;
  }
  const monthOffsetOf = (d) => Math.max(-1, Math.min(G.monthOffsetOfDay(s.days) + 1, G.monthOffsetOfDay(d)));
  const dateNum = (d) => G.dateNumOf(d);

  function viewCalendar() {
    const sel = ui.calDay || s.day;
    const m = G.monthInfo(ui.calMonth);
    const sched = G.schedule(s, G.horizonDay(s));
    const only = ui.calCustomer;
    const cells = [];
    for (let i = 0; i < m.lead; i++) cells.push('<div class="cal-cell blank" aria-hidden="true"></div>');
    for (let i = 0; i < m.daysInMonth; i++) cells.push(calCell(m.firstDay + i, sel, sched, only));
    while (cells.length % 7) cells.push('<div class="cal-cell blank" aria-hidden="true"></div>');
    const opts = s.customers.map((c) => `<option value="${esc(c.id)}" ${only === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    const list = months();
    const monthOpts = list.map((off) => {
      const x = G.monthInfo(off);
      return `<option value="${off}" ${ui.calMonth === off ? 'selected' : ''}>${x.year}年${x.month}月${off === G.monthOffsetOfDay(s.day) ? '（今月）' : ''}</option>`;
    }).join('');
    const note = ui.calMonth < 0 ? '開店前の月です'
      : m.firstDay + m.daysInMonth - 1 > s.days ? `最終日${lastDay()}より後は、ジャンプし続けた場合の見込みです。15日と月末は締め日です`
      : '日付を押すと、その日の入金予定者・貸付した債務者・入金者が一覧で出ます。15日と月末は締め日です';
    return `
      <div class="cal-layout">
        <section class="panel">
          <header class="panel-h">
            <button class="ghost small" data-act="cal-month" data-offset="${ui.calMonth - 1}" ${ui.calMonth <= list[0] ? 'disabled' : ''} aria-label="前の月">‹</button>
            <h2>${m.year}年${m.month}月</h2>
            <button class="ghost small" data-act="cal-month" data-offset="${ui.calMonth + 1}" ${ui.calMonth >= list[list.length - 1] ? 'disabled' : ''} aria-label="次の月">›</button>
            <select id="cal-month-select" aria-label="月を選ぶ">${monthOpts}</select>
            <button class="ghost small" data-act="cal-month" data-offset="${G.monthOffsetOfDay(s.day)}" ${ui.calMonth === G.monthOffsetOfDay(s.day) ? 'disabled' : ''}>今月</button>
            <select id="cal-customer" class="right" aria-label="顧客で絞り込み"><option value="">すべての顧客</option>${opts}</select>
          </header>
          <p class="help cal-note">${note}</p>
          <div class="cal-legend"><span class="chip due">入金予定（ジャンプ金）</span><span class="chip in">入金</span><span class="chip out">貸付</span><span class="chip unk">不明入金</span><span class="chip bad">延滞・夜逃げ</span><span class="chip close">締め（15日・月末）</span></div>
          <div class="cal-grid">
            ${['日', '月', '火', '水', '木', '金', '土'].map((w, i) => `<div class="cal-w ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</div>`).join('')}
            ${cells.join('')}
          </div>
        </section>
        <section class="panel day-detail">${dayDetailHtml(sel, sched, only)}</section>
      </div>`;
  }

  // その日の帳簿：入金予定者・貸付・入金者（不明入金と充当も）
  function dayBook(d, sched, only) {
    const mine = (id) => !only || id === only;
    const txs = s.txs.filter((t) => t.day === d && mine(t.customerId));
    let due = [];
    if (d > s.day) {
      due = (sched[d] || []).filter((e) => mine(e.customer.id)).map((e) => ({
        c: e.customer, loan: e.loan, jump: e.jump, payoff: e.payoff, first: e.first, result: null,
      }));
    } else {
      for (const a of txs.filter((t) => t.type === 'accrue' || t.type === 'lateAccrue')) {
        const loan = G.loanOf(s, a.loanId);
        const res = txs.filter((t) => t.loanId === a.loanId && ['jump', 'jumpPlus', 'payoff', 'partial', 'overdue'].includes(t.type));
        const paid = res.filter((t) => G.TX[t.type].pay).reduce((q, t) => q + t.amount, 0);
        const last = res[res.length - 1];
        const shown = res.filter((t) => G.TX[t.type].pay).map(txSummary);
        if (last && last.type === 'overdue') shown.push('延滞');
        due.push({
          c: G.customerOf(s, a.customerId), loan, jump: a.accrued, payoff: a.principal + a.accrued, paid,
          result: a.type === 'lateAccrue' ? '延滞中（ジャンプ金が上乗せ）' : shown.join(' → ') || '—',
          bad: a.type === 'lateAccrue' || (last && (last.type === 'overdue' || last.type === 'partial')),
        });
      }
    }
    const lends = txs.filter((t) => t.type === 'lend').map((t) => ({ t, loan: G.loanOf(s, t.loanId), c: G.customerOf(s, t.customerId) }));
    const payers = txs.filter((t) => G.TX[t.type].cash > 0).map((t) => ({ t, c: G.customerOf(s, t.customerId), loan: G.loanOf(s, t.loanId) }));
    const allocs = txs.filter((t) => t.type === 'allocate' || t.type === 'allocCancel').map((t) => ({ t, c: G.customerOf(s, t.customerId), loan: G.loanOf(s, t.loanId) }));
    const unknowns = only ? [] : s.unknowns.filter((u) => u.day === d);
    const refunds = only ? [] : s.unknowns.flatMap((u) => u.refunds.filter((r) => r.day === d).map((r) => ({ u, amount: r.amount })));
    return {
      due, lends, payers, allocs, unknowns, refunds,
      dueSum: sum(due, (x) => x.jump),
      lendSum: sum(lends, (x) => x.t.amount),
      transferSum: sum(lends, (x) => x.t.transfer),
      inSum: sum(payers, (x) => x.t.amount) + sum(unknowns, (u) => u.amount),
      lateNow: d === s.day ? s.loans.filter((l) => l.status === '延滞' && mine(l.customerId)) : [],
    };
  }

  function calCell(d, sel, sched, only) {
    const wd = G.weekdayOf(d);
    const state = d < 1 ? 'closed' : d < s.day ? 'past' : d === s.day ? 'today' : d > s.days ? 'proj' : 'future';
    const chips = [];
    let total = 0;
    if (d >= 1 && d <= s.day) {
      const b = dayBook(d, sched, only);
      const jumps = b.payers.filter((x) => x.t.type === 'jump' || x.t.type === 'jumpPlus').length;
      const late = b.due.filter((x) => x.bad).length;
      const fled = s.txs.filter((t) => t.day === d && t.type === 'flee' && (!only || t.customerId === only)).length;
      if (b.inSum) chips.push(`<span class="chip in">入金 ${num(b.inSum)}</span>`);
      if (jumps) chips.push(`<span class="chip in">ジャンプ ${jumps}</span>`);
      if (b.unknowns.length) chips.push(`<span class="chip unk">不明 ${num(sum(b.unknowns, (u) => u.amount))}</span>`);
      if (b.lendSum) chips.push(`<span class="chip out">貸付 ${num(b.lendSum)}</span>`);
      if (b.refunds.length) chips.push(`<span class="chip out">返金 ${num(sum(b.refunds, (r) => r.amount))}</span>`);
      if (late) chips.push(`<span class="chip bad">延滞 ${late}</span>`);
      if (fled) chips.push(`<span class="chip bad">夜逃げ ${fled}</span>`);
    } else if (d > s.day) {
      const list = (sched[d] || []).filter((e) => !only || e.customer.id === only);
      // 名字だけだと「開業」「一発」などが言葉に見えるので、フルネームで出す
      list.slice(0, 3).forEach((e) => chips.push(`<span class="chip due who" title="${esc(e.customer.name)}のジャンプ金 ${yen(e.jump)}"><span class="nm">${esc(e.customer.name)}</span><span class="amt">${num(e.jump)}</span></span>`));
      if (list.length > 3) chips.push(`<span class="chip due">ほか${list.length - 3}名</span>`);
      if (list.length > 1) total = sum(list, (e) => e.jump);   // 1人だけなら合計は同じなので出さない
    }
    if (d >= 1 && G.closingOf(d)) chips.unshift(closingChip(d, only));
    const label = `${G.fmtDay(d)} ${chips.length ? '予定・取引あり' : ''}`;
    return `<button class="cal-cell ${state} ${d === sel ? 'sel' : ''} ${wd === 0 ? 'sun' : wd === 6 ? 'sat' : ''}" data-act="cal-day" data-day="${d}" aria-label="${esc(label)}" ${d === sel ? 'aria-pressed="true"' : ''}>
      <span class="cal-top"><span class="cal-date">${dateNum(d)}</span>${d === s.day ? '<span class="today-tag">今日</span>' : ''}</span>
      <span class="cal-items">${chips.join('')}</span>
      ${total ? `<span class="cal-total">計 ${yen(total)}</span>` : ''}
      <span class="cal-dots" aria-hidden="true">${chips.length ? '●'.repeat(Math.min(chips.length, 3)) : ''}</span>
    </button>`;
  }

  // 締め日のマス。済んだ締めは結果、これからの締めは不渡りの見込み
  const plannedOn = (d, only) => s.loans.filter((l) => l.status === '夜逃げ' && G.fuwatariDayOf(s, l) === d && (!only || l.customerId === only));
  function closingChip(d, only) {
    const rec = s.closings.find((c) => c.day === d);
    if (rec) {
      const n = rec.loanIds.filter((id) => !only || G.loanOf(s, id).customerId === only).length;
      return n ? `<span class="chip close hit">締め 不渡り${n}件</span>` : '<span class="chip close">締め 不渡りなし</span>';
    }
    const n = plannedOn(d, only).length;
    return `<span class="chip close ${n ? 'hit' : ''}">締め日${n ? ` 不渡り見込み${n}` : ''}</span>`;
  }

  function closingDetailHtml(d, only) {
    const kind = G.closingOf(d);
    const rec = s.closings.find((c) => c.day === d);
    const row = (l, c) => `<tr><td>${custLink(c)}</td><td>${loanLink(l)}</td><td class="num"><b>${yen(l.fuwatari || l.principal)}</b></td>
      <td>${G.fmtDay(l.lateSince)}</td><td>${dayLink(l.closedDay)}</td><td class="num">${d - l.lateSince}日</td></tr>`;
    const table = (list) => `<div class="table-wrap"><table class="data compact">
      <thead><tr><th>顧客</th><th>貸付</th><th class="num">不渡り元金</th><th>遅れた期日</th><th>夜逃げした日</th><th class="num">締め日の遅れ</th></tr></thead>
      <tbody>${list.map((l) => row(l, G.customerOf(s, l.customerId))).join('')}</tbody></table></div>`;
    if (rec) {
      const list = rec.loanIds.map((id) => G.loanOf(s, id)).filter((l) => !only || l.customerId === only);
      const prev = s.closings.filter((c) => c.day < d).pop() || { sales: 0, expenses: 0, fuwatari: 0, net: 0 };
      return `<h3 class="sec">締め（${kind}） <span class="sub">不渡り${list.length}件・元金${yen(sum(list, (l) => l.fuwatari))}を貸付総元金から引いた</span></h3>
        ${list.length ? table(list) : '<p class="empty">この締めで不渡りになった貸付はありません。</p>'}
        <p class="help">この締めの時点の累計：</p>${plLine(rec)}
        <p class="help">前の締めからの増減：総売上 +${num(rec.sales - prev.sales)}／経費 +${num(rec.expenses - prev.expenses)}／不渡り +${num(rec.fuwatari - prev.fuwatari)}／純利 ${rec.net - prev.net < 0 ? '' : '+'}${signed(rec.net - prev.net)}</p>`;
    }
    const list = d >= s.day ? plannedOn(d, only) : [];
    return `<h3 class="sec">締め（${kind}） <span class="sub">${d === s.day ? '今日の終わりに締めます' : 'この日の終わりに締めます'}</span></h3>
      ${list.length ? `<p class="help">今のままだと、次の${list.length}件・元金${yen(sum(list, (l) => l.principal))}を不渡りにします。</p>${table(list)}`
        : '<p class="empty">今のところ、この締めで不渡りになる見込みの貸付はありません。</p>'}
      <p class="help">期日から2週間以上遅れて連絡がつかない（夜逃げした）客を不渡りにして、元金を貸付総元金から引きます。連絡がつく延滞客は不渡りにしません。</p>`;
  }

  function unknownStatus(u) {
    const left = G.unknownLeft(u);
    const lines = u.allocations.map((a, i) => {
      const loan = G.loanOf(s, a.loanId), c = G.customerOf(s, loan.customerId);
      const what = `${custLink(c)} ${loanLink(loan)} へ充当 ${yen(a.amount)}（${G.fmtDay(a.day)}）`;
      if (a.canceled) return `<span class="sub"><s>${what}</s> → ${G.fmtDay(a.canceledDay)}に取消</span>`;
      const chk = G.canCancelAllocation(s, u.id, i);
      return `<span class="sub">${what} ${chk.ok
        ? `<button class="link danger" data-act="alloc-cancel" data-id="${u.id}" data-idx="${i}">取り消す</button>`
        : `<span class="muted" title="${esc(chk.reason)}">（取消不可）</span>`}</span>`;
    });
    u.refunds.forEach((r) => lines.push(`<span class="sub">返金（組戻し） ${yen(r.amount)}（${G.fmtDay(r.day)}）</span>`));
    const owner = u.revealed ? `<span class="sub">判明：${esc(G.customerOf(s, u.ownerId).name)}（${G.fmtDay(u.revealDay)}に電話）</span>` : '<span class="sub">持ち主はまだ不明</span>';
    let label = '<span class="ok">処理済み</span>';
    if (left > 0) label = `<span class="bad">未充当 ${yen(left)}</span>`;
    else if (u.refunded === u.amount) label = '<span class="muted">全額返金済み</span>';
    else if (u.refunded === 0) label = '<span class="ok">充当済み</span>';
    return { left, html: `${label}${owner}${lines.join('')}` };
  }

  // 未充当が残っている不明入金に出す操作ボタン
  const unknownActions = (u) => (G.unknownLeft(u) > 0
    ? `<span class="btns"><button class="ghost small" data-act="alloc-open" data-id="${u.id}">充当する</button><button class="ghost small" data-act="refund" data-id="${u.id}">返金する</button></span>` : '');

  function dayDetailHtml(d, sched, only) {
    const tag = d < 1 ? '<span class="badge st-断った">開店前</span>'
      : d < s.day ? '<span class="badge st-完済">済み</span>'
      : d === s.day ? '<span class="badge st-来店中">今日</span>'
      : d > s.days ? '<span class="badge st-返済中">見込み</span>' : '<span class="badge st-返済中">予定</span>';
    const head = `<header class="panel-h"><h2>${G.fmtDayLong(d)}</h2><span class="sub">${d >= 1 ? `${d}日目` : ''}</span>${tag}</header>`;
    if (d < 1) return `${head}<p class="empty">開店前の日です。取引はありません。</p>`;
    const b = dayBook(d, sched, only);
    const future = d > s.day;
    const inJump = sum(b.payers, (x) => x.t.toInterest), inPrin = sum(b.payers, (x) => x.t.toPrincipal), inUnk = sum(b.unknowns, (u) => u.amount);

    const summary = `<div class="day-sum">
      <div><span>入金予定者</span><b>${b.due.length}名</b><small>${yen(b.dueSum)}</small></div>
      <div><span>貸付した債務者</span><b>${b.lends.length}件</b><small>元金 ${yen(b.lendSum)}</small>${b.lends.length ? `<em>振込 ${num(b.transferSum)}／手数料 ${num(b.lendSum - b.transferSum)}</em>` : ''}</div>
      <div><span>入金者</span><b>${b.payers.length + b.unknowns.length}件</b><small class="in">${yen(b.inSum)}</small>
        ${b.inSum ? `<em>ジャンプ ${num(inJump)}／元金 ${num(inPrin)}${inUnk ? `／不明 ${num(inUnk)}` : ''}</em>` : ''}</div>
    </div>`;

    const dueRows = b.due.map((x) => `<tr>
      <td>${custLink(x.c)}${x.first === false ? '<span class="sub">ジャンプし続けた場合</span>' : ''}</td><td>${loanLink(x.loan)}</td>
      <td class="num"><b>${yen(x.jump)}</b></td>
      ${future ? `<td class="num">${yen(x.payoff)}</td>` : `<td><span class="${x.bad ? 'bad' : 'ok'}">${esc(x.result)}</span></td><td class="num">${x.paid ? yen(x.paid) : '—'}</td>`}
    </tr>`).join('');
    const dueTable = b.due.length ? `<div class="table-wrap"><table class="data compact">
      <thead><tr><th>顧客</th><th>貸付</th><th class="num">ジャンプ金</th>${future ? '<th class="num">完済金額</th>' : '<th>結果（内訳）</th><th class="num">入金</th>'}</tr></thead>
      <tbody>${dueRows}</tbody></table></div>` : `<p class="empty">${future ? 'この日の入金予定はありません。' : 'この日に期日を迎えた客はいません。'}</p>`;

    const lendTable = b.lends.length ? `<div class="table-wrap"><table class="data compact">
      <thead><tr><th>顧客</th><th>貸付</th><th>①②</th><th class="num">元金</th><th>③初回</th><th class="num">④振込金額</th><th class="num">手数料（売上）</th><th>⑤振込先口座</th></tr></thead>
      <tbody>${b.lends.map((x) => `<tr><td>${custLink(x.c)}</td><td>${loanLink(x.loan)}</td><td>${termsCell(x.loan)}</td><td class="num">${yen(x.t.amount)}</td>
        <td>${dayLink(x.loan.firstDue)}</td><td class="num out">${yen(x.t.transfer)}</td><td class="num in">${x.t.fee ? yen(x.t.fee) : '—'}</td>
        <td class="wrap">${x.loan.account ? esc(x.loan.account) : '<span class="muted">未入力</span>'}</td></tr>`).join('')}</tbody></table></div>`
      : `<p class="empty">${future ? 'まだ先の日です。' : 'この日の貸付はありません。'}</p>`;

    const allocFrom = (t) => {
      const u = s.unknowns.find((v) => v.allocations.some((a) => a.txId === t.id || (t.type === 'allocCancel' && a.canceledDay === d && a.loanId === t.loanId && a.amount === -t.amount)));
      return u ? `（${G.fmtDay(u.day)}受付分）` : '';
    };
    const payRows = [
      ...b.payers.map((x) => `<tr><td>${custLink(x.c)}</td><td><b>${esc(txSummary(x.t))}</b><span class="sub">${loanLink(x.loan)}</span></td>
        <td class="num in">${yen(x.t.amount)}</td><td></td></tr>`),
      ...b.unknowns.map((u) => {
        const st = unknownStatus(u);
        return `<tr class="unk-row"><td><b>不明入金</b></td><td>${st.html}</td><td class="num in">${yen(u.amount)}</td><td>${unknownActions(u)}</td></tr>`;
      }),
      ...b.allocs.map((x) => `<tr class="muted-row"><td>${custLink(x.c)}</td><td>${esc(txSummary(x.t))}<span class="sub">${loanLink(x.loan)}${allocFrom(x.t)}・現金の動きなし</span></td>
          <td class="num muted">${yen(x.t.amount)}</td><td></td></tr>`),
      ...b.refunds.map((r) => `<tr class="muted-row"><td>返金</td><td>返金（組戻し）<span class="sub">${G.fmtDay(r.u.day)}の不明入金から・手持ち資金から出金</span></td>
          <td class="num out">−${num(r.amount)}円</td><td></td></tr>`),
    ];
    const outSum = sum(b.refunds, (r) => r.amount);
    const payTable = payRows.length ? `<div class="table-wrap"><table class="data compact">
      <thead><tr><th>入金者</th><th>内訳</th><th class="num">金額</th><th></th></tr></thead>
      <tbody>${payRows.join('')}</tbody>
      <tfoot><tr><th colspan="2">入金合計（充当・取消は含まない）</th><th class="num">${yen(b.inSum)}</th><th></th></tr>
        ${outSum ? `<tr><th colspan="2">返金（出金）</th><th class="num out">−${num(outSum)}円</th><th></th></tr>` : ''}</tfoot></table></div>`
      : `<p class="empty">${future ? 'まだ先の日です。' : 'この日の入金はありません。'}</p>`;

    let html = `${head}${summary}${G.closingOf(d) ? closingDetailHtml(d, only) : ''}
      <h3 class="sec">入金予定者 <span class="sub">${b.due.length}名・ジャンプ金 計${yen(b.dueSum)}</span></h3>${dueTable}
      <h3 class="sec">貸付した債務者 <span class="sub">${b.lends.length}件・元金 計${yen(b.lendSum)}・振込 計${yen(b.transferSum)}</span></h3>${lendTable}
      <h3 class="sec">入金者 <span class="sub">${b.payers.length + b.unknowns.length}件・計${yen(b.inSum)}</span></h3>${payTable}`;
    if (future) html += '<p class="help">ジャンプ金は、その期日に払わないと延滞になる額です。2回目以降は、それまでジャンプ金だけ入れ続けた場合の見込みです。</p>';
    if (b.lateNow.length) {
      html += `<h3 class="sec">延滞中の客</h3><ul class="plain">${b.lateNow.map((l) =>
        `<li>${custLink(G.customerOf(s, l.customerId))} ${loanLink(l)} 未回収 ${yen(G.owedOf(l))}・延滞${l.overdueDays}日 ${riskOf(l)}</li>`).join('')}</ul>
        <p class="help">取り立ては「本日の業務」から行います。</p>`;
    }
    const logs = s.log.filter((l) => l.day === d);
    if (logs.length) html += `<details class="history"><summary>この日の出来事（${logs.length}件）</summary><ul class="log small">${logs.map((e) => `<li class="${e.kind}">${esc(e.text)}</li>`).join('')}</ul></details>`;
    return html;
  }

  // ---- 不明入金の充当 ----

  function renderAlloc() {
    const box = $('#alloc');
    if (!ui.alloc || !s) { box.hidden = true; return; }
    const u = G.unknownOf(s, ui.alloc.id);
    if (!u || G.unknownLeft(u) <= 0) { ui.alloc = null; box.hidden = true; return; }
    const left = G.unknownLeft(u);
    const loans = s.loans.filter(G.isActive);
    if (ui.alloc.loanId == null) {
      const own = u.revealed && loans.find((l) => l.customerId === u.ownerId);
      ui.alloc.loanId = own ? own.id : '';
    }
    const opts = loans.map((l) => {
      const c = G.customerOf(s, l.customerId);
      return `<option value="${l.id}" ${ui.alloc.loanId === l.id ? 'selected' : ''}>No.${l.id} ${esc(c.name)}（${l.status}・未払いジャンプ金 ${yen(l.accrued)}・元金 ${yen(l.principal)}）</option>`;
    }).join('');
    $('#alloc-body').innerHTML = `
      <h2>不明入金を充当する</h2>
      <dl class="facts">
        <dt>受付日</dt><dd>${G.fmtDayLong(u.day)}</dd>
        <dt>金額</dt><dd>${yen(u.amount)}<small>（充当済み ${yen(u.allocated)}・返金 ${yen(u.refunded)}・未充当 <b>${yen(left)}</b>）</small></dd>
        <dt>持ち主</dt><dd>${u.revealed ? `<b>${esc(G.customerOf(s, u.ownerId).name)}</b><small>（${G.fmtDay(u.revealDay)}に本人から電話）</small>` : 'まだわかっていません'}</dd>
      </dl>
      ${loans.length ? `<form id="alloc-form" class="terms" novalidate>
        <div class="field"><label for="alloc-loan">充当先の貸付</label>
          <select id="alloc-loan" name="alloc-loan"><option value="">選んでください</option>${opts}</select></div>
        <div class="field"><label for="alloc-amount">充当する金額</label>
          <span class="unit-input"><input type="number" id="alloc-amount" name="alloc-amount" min="1" step="1" value="${ui.alloc.amount == null ? left : Number.isFinite(ui.alloc.amount) ? ui.alloc.amount : ''}"><span>円</span></span></div>
        <div class="quote" id="alloc-preview"></div>
        <div class="actions"><button type="submit" class="primary">充当する</button><button type="button" class="ghost" data-act="alloc-close">やめる</button>
          <button type="button" class="ghost right" data-act="refund" data-id="${u.id}">充当せずに返金する（${yen(left)}）</button></div>
      </form>` : `<p class="empty">返済中・延滞中の貸付がないため、充当できません。持ち主に返すなら返金してください。</p>
        <div class="actions"><button class="ghost" data-act="alloc-close">閉じる</button><button class="ghost right" data-act="refund" data-id="${u.id}">返金する（${yen(left)}）</button></div>`}`;
    box.hidden = false;
    updateAllocPreview();
  }

  function updateAllocPreview() {
    const box = $('#alloc-preview');
    if (!box || !ui.alloc) return;
    const u = G.unknownOf(s, ui.alloc.id);
    const left = G.unknownLeft(u);
    const loan = ui.alloc.loanId ? G.loanOf(s, ui.alloc.loanId) : null;
    const amount = ui.alloc.amount == null ? left : ui.alloc.amount;
    if (!loan) { box.innerHTML = '<p class="verdict warn">充当先の貸付を選んでください。</p>'; return; }
    const max = Math.min(left, G.owedOf(loan));
    if (!(Number.isInteger(amount) && amount >= 1 && amount <= max)) {
      box.innerHTML = `<p class="verdict bad">1円〜${yen(max)}で入力してください（未充当 ${yen(left)}・この貸付の残り ${yen(G.owedOf(loan))}）。</p>`;
      return;
    }
    const toJump = Math.min(amount, loan.accrued), toP = amount - toJump;
    const after = loan.principal - toP;
    let note = '';
    if (loan.principal - toP <= 0 && loan.accrued - toJump <= 0) note = 'この充当で完済になります。';
    else if (loan.status === '延滞' && loan.accrued - toJump === 0) note = `ジャンプ金が満額そろってジャンプ成立。次回の期日は元の予定どおり${G.fmtDay(loan.due)}です（払った日から数え直しません）。`;
    else if (loan.status === '延滞') note = `未払いジャンプ金があと${yen(loan.accrued - toJump)}残るので、ジャンプは成立せず延滞のままです。`;
    box.innerHTML = `<p class="breakdown">内訳：<b>ジャンプ(${num(toJump)})＋元金詰め(${num(toP)})</b></p>
      <dl class="quote-grid">
        <div><dt>充当前の元金</dt><dd>${yen(loan.principal)}</dd></div>
        <div><dt>充当後の元金</dt><dd>${yen(after)}</dd></div>
        <div><dt>次のジャンプ金</dt><dd>${yen(G.jumpOf(loan, after))}<small>今は${yen(G.nextJumpOf(loan))}</small></dd></div>
      </dl>
      <p class="verdict good">未払いジャンプ金に先に充当し、多い分で元金を詰めます。手持ち資金は動きません（受付日に受け取り済み）。間違えたら、この充当のあとに同じ貸付の取引がない間は取り消せます。${note}</p>`;
  }

  function unknownTableHtml(list) {
    if (!list.length) return '<p class="empty">不明入金はありません。</p>';
    return `<div class="table-wrap"><table class="data compact">
      <thead><tr><th>受付日</th><th class="num">金額</th><th class="num">充当済み</th><th class="num">返金</th><th class="num">未充当</th><th>状況・履歴</th><th></th></tr></thead>
      <tbody>${list.map((u) => {
        const st = unknownStatus(u);
        return `<tr><td>${dayLink(u.day)}</td><td class="num">${yen(u.amount)}</td><td class="num">${yen(u.allocated)}</td><td class="num">${yen(u.refunded)}</td>
          <td class="num"><b class="${st.left ? 'bad' : ''}">${yen(st.left)}</b></td><td>${st.html}</td><td>${unknownActions(u)}</td></tr>`;
      }).join('')}</tbody></table></div>`;
  }

  // ---- 元金表 ----

  const LOAN_SORTS = {
    id: ['貸付No順', (a, b) => a.id - b.id],
    balance: ['元金残高の多い順', (a, b) => b.principal - a.principal],
    due: ['次回期日の近い順', (a, b) => (a.status === '返済中' ? a.due : 999) - (b.status === '返済中' ? b.due : 999)],
    apr: ['年利の高い順', (a, b) => G.aprOf(b.rate, b.cycle) - G.aprOf(a.rate, a.cycle)],
  };

  function viewLoans() {
    const t = G.totals(s);
    const counts = {};
    s.loans.forEach((l) => { counts[l.status] = (counts[l.status] || 0) + 1; });
    const chips = [['すべて', s.loans.length], ...['返済中', '延滞', '完済', '夜逃げ', '不渡り'].filter((k) => counts[k]).map((k) => [k, counts[k]])].map(([k, n]) =>
      `<button class="filter ${ui.loans.status === k ? 'on' : ''}" data-act="filter" data-scope="loans" data-value="${k}">${k}<span>${n}</span></button>`).join('');
    const sorts = Object.entries(LOAN_SORTS).map(([k, [label]]) => `<option value="${k}" ${ui.loans.sort === k ? 'selected' : ''}>${label}</option>`).join('');
    let rows = s.loans.slice();
    if (ui.loans.status !== 'すべて') rows = rows.filter((l) => l.status === ui.loans.status);
    rows.sort(LOAN_SORTS[ui.loans.sort][1]);

    const body = rows.length ? rows.map((l) => {
      const c = G.customerOf(s, l.customerId);
      return `<tr class="clickable" ${rowAttrs('open-loan', l.id)}>
        <td>No.${l.id}</td>
        <td>${custLink(c)}</td>
        <td>${G.fmtDay(l.lentDay)}</td>
        <td class="num">${yen(l.lent)}</td>
        <td>${termsCell(l)}</td>
        ${l.status === '不渡り'
          ? `<td class="num muted" title="締めで不渡りにして、貸付総元金から引いた元金"><s>${yen(l.principal)}</s><span class="sub">${G.fmtDay(l.fuwatariDay)}不渡り</span></td><td class="num muted"><s>${l.accrued ? yen(l.accrued) : '—'}</s></td>`
          : l.status === '夜逃げ'
            ? `<td class="num"><b>${yen(l.principal)}</b><span class="sub bad">不渡り未計上</span></td><td class="num muted"><s>${l.accrued ? yen(l.accrued) : '—'}</s></td>`
            : `<td class="num"><b>${yen(l.principal)}</b></td><td class="num">${l.accrued ? yen(l.accrued) : '—'}</td>`}
        <td class="num">${G.isActive(l) ? yen(G.nextJumpOf(l)) : '—'}</td>
        <td class="num">${G.isActive(l) ? yen(G.owedOf(l) + G.nextJumpOf(l)) : '—'}</td>
        <td class="num">${l.jumps ? `${l.jumps}回` : '—'}</td>
        <td class="num">${l.interestPaid ? yen(l.interestPaid) : '—'}</td>
        <td class="num">${l.lent - l.principal ? yen(l.lent - l.principal) : '—'}</td>
        <td>${l.status === '返済中' ? G.fmtDay(l.due) : l.status === '延滞' ? `<span class="bad">延滞${l.overdueDays}日</span>`
          : l.status === '夜逃げ' ? `<span class="bad">連絡不通・遅れ${G.lateDaysOf(s, l)}日</span><span class="sub">${G.fmtDay(G.fuwatariDayOf(s, l))}の締めで不渡り</span>` : '—'}</td>
        <td>${badge(l.status)}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="14" class="empty">まだ貸付はありません。</td></tr>';

    const f = (k) => yen(sum(rows, (l) => l[k]));
    const live = rows.filter(G.isActive);
    const fLive = (k) => yen(sum(live, (l) => l[k]));
    return `
      <div class="stat-row eight">
        <div class="stat"><span>貸付総元金</span><b>${yen(t.balance)}</b><em>返済中・延滞・夜逃げ（未計上）の元金</em></div>
        <div class="stat"><span>未払いジャンプ金</span><b>${yen(t.accrued)}</b></div>
        <div class="stat"><span>ジャンプ金累計</span><b class="in">${yen(t.interestPaid)}</b></div>
        <div class="stat"><span>回収済元金</span><b>${yen(t.principalBack)}</b></div>
        <div class="stat"><span>不渡り（計上済み）</span><b class="${t.fuwatari ? 'bad' : ''}">${yen(t.fuwatari)}</b><em>${t.fuwatariCount}件</em></div>
        <div class="stat"><span>夜逃げ（不渡り未計上）</span><b class="${t.fled ? 'bad' : ''}">${yen(t.fled)}</b><em>${t.fledCount}件・締めで不渡りに</em></div>
        <div class="stat"><span>不明入金（預かり）</span><b class="${t.unknownHeld ? 'unk' : ''}">${yen(t.unknownHeld)}</b></div>
      </div>
      <section class="panel">
        <header class="panel-h"><h2>元金表</h2><span class="sub">貸付ごとの元金とジャンプ金 ・ 行をクリックすると取引明細が開きます</span></header>
        ${collectedLine(t.interestPaid, t.principalBack)}
        <div class="toolbar">
          <div class="filters">${chips}</div>
          <select id="loan-sort" class="right" aria-label="並び順">${sorts}</select>
        </div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>貸付No</th><th>顧客</th><th>貸付日</th><th class="num">元金</th><th>条件</th>
            <th class="num">元金残高</th><th class="num">未払いジャンプ金</th><th class="num">次のジャンプ金</th><th class="num">完済金額</th>
            <th class="num">ジャンプ</th><th class="num">ジャンプ金累計</th><th class="num">回収済元金</th><th>次回期日</th><th>状態</th></tr></thead>
          <tbody>${body}</tbody>
          ${rows.length ? `<tfoot><tr><th colspan="3">合計（${rows.length}件）</th><th class="num">${f('lent')}</th><th></th>
            <th class="num">${yen(sum(rows.filter(G.onBooks), (l) => l.principal))}</th><th class="num">${fLive('accrued')}</th>
            <th class="num">${yen(sum(live, G.nextJumpOf))}</th><th class="num">${yen(sum(live, (l) => G.owedOf(l) + G.nextJumpOf(l)))}</th>
            <th class="num">${sum(rows, (l) => l.jumps)}回</th><th class="num">${f('interestPaid')}</th><th class="num">${yen(sum(rows, (l) => l.lent - l.principal))}</th><th colspan="2"></th></tr></tfoot>` : ''}
        </table></div>
        <p class="help">元金残高は、まだ返ってきていない元金です。次のジャンプ金は元金残高 × 利率（円未満切り捨て）。ジャンプ金より多く入金があった分は元金を詰めます。夜逃げした貸付の元金は、不渡りに計上するまで合計（貸付総元金）に残します。不渡りにした貸付は取り消し線で残し、合計には入れません。</p>
      </section>
      ${plPanelHtml()}
      <section class="panel">
        <header class="panel-h"><h2>不明入金（仮受金）</h2><span class="sub">誰からかわからない入金。持ち主がわかったら「充当する」で貸付に充てます。充当するまでは自分のお金ではないので、純利にも数えません</span></header>
        ${unknownTableHtml(s.unknowns.slice().reverse())}
      </section>`;
  }

  // 損益（純利）：総売上 − 経費 − 不渡り。経費の内訳・締めの記録・不渡りの予定
  function plPanelHtml() {
    const p = G.pl(s), goal = s.goal;
    const costRows = Object.entries(G.COSTS).map(([k, label]) => {
      const list = s.costs.filter((c) => c.kind === k);
      return `<tr><td>${label}</td><td class="num">${list.length}件</td><td class="num">${yen(sum(list, (c) => c.amount))}</td></tr>`;
    }).join('');
    const plan = G.fuwatariPlan(s);
    const closeRows = s.closings.map((c) => `<tr><td>${dayLink(c.day)}<span class="sub">${c.kind}</span></td>
      <td class="num">${c.loanIds.length ? `<span class="bad">${c.loanIds.length}件</span>` : '0件'}</td><td class="num">${c.amount ? `<span class="bad">${yen(c.amount)}</span>` : '—'}</td>
      <td class="num">${yen(c.sales)}</td><td class="num">${yen(c.expenses)}</td><td class="num">${yen(c.fuwatari)}</td><td class="num"><b>${signedYen(c.net)}</b></td></tr>`).join('');
    const nextRow = s.over ? '' : `<tr class="muted-row"><td>${dayLink(plan.day)}<span class="sub">${G.closingOf(plan.day)}・予定</span></td>
      <td class="num">${plan.due.length}件</td><td class="num">${plan.due.length ? yen(sum(plan.due, (l) => l.principal)) : '—'}</td><td colspan="4" class="muted">締めの日の終わりに計上</td></tr>`;
    return `<section class="panel">
      <header class="panel-h"><h2>損益（純利）</h2><span class="sub">目標：最終日${lastDay()}の締めのあとの純利 ${yen(goal)}</span>
        <button class="link right" data-act="period-open">期間・目標を変える</button></header>
      ${plLine(p)}
      <div class="stat-row four tight">
        <div class="stat"><span>総売上</span><b class="in">${yen(p.sales)}</b><em>ジャンプ金 ${num(p.jumpSales)}＋振込手数料 ${num(p.feeSales)}</em></div>
        <div class="stat"><span>経費</span><b>${yen(p.expenses)}</b></div>
        <div class="stat"><span>不渡り（締めで計上）</span><b class="${p.fuwatari ? 'bad' : ''}">${yen(p.fuwatari)}</b></div>
        <div class="stat"><span>純利 / 目標</span><b class="${p.net < 0 ? 'bad' : ''}">${signedYen(p.net)}</b><em>目標まで ${yen(Math.max(0, goal - p.net))}</em></div>
      </div>
      <div class="cols">
        <div><h3 class="sec">経費の内訳</h3>
          <div class="table-wrap"><table class="data compact">
            <thead><tr><th>項目</th><th class="num">件数</th><th class="num">金額</th></tr></thead>
            <tbody>${costRows}</tbody>
            <tfoot><tr><th>合計</th><th class="num">${s.costs.length}件</th><th class="num">${yen(p.expenses)}</th></tr></tfoot></table></div></div>
        <div><h3 class="sec">締めの記録 <span class="sub">15日・月末</span></h3>
          <div class="table-wrap"><table class="data compact">
            <thead><tr><th>締め日</th><th class="num">不渡り</th><th class="num">不渡り元金</th><th class="num">総売上</th><th class="num">経費</th><th class="num">不渡り累計</th><th class="num">純利</th></tr></thead>
            <tbody>${closeRows}${nextRow}</tbody></table></div>
          <p class="help">総売上・経費・不渡り累計・純利は、その締めの時点の累計です。</p></div>
      </div>
      <h3 class="sec">不渡りの予定 <span class="sub">夜逃げして連絡がつかない客</span></h3>
      ${plan.due.length || plan.later.length ? fuwatariTableHtml(plan) : '<p class="empty">連絡がつかない客はいません。</p>'}
      <p class="help">総売上は回収したジャンプ金（利息）と振込手数料（元金から天引きした分）の合計で、返ってきた元金は売上に入れません。経費は身辺調査費・罰金・チラシ代。不渡りは、期日から2週間以上遅れて連絡がつかない客の元金を、15日と月末の締めで計上した額です。純利 ＝ 総売上 − 経費 − 不渡り。</p>
    </section>`;
  }

  // ---- 顧客カルテ・貸付詳細（右から出る詳細パネル） ----

  function renderDrawer(focus) {
    const el = $('#drawer'), scrim = $('#scrim');
    if (!ui.drawer || !s) { el.hidden = true; scrim.hidden = true; return; }
    el.innerHTML = ui.drawer.kind === 'loan' ? loanCard(ui.drawer.id) : ui.drawer.edit ? customerForm(ui.drawer.id) : customerCard(ui.drawer.id);
    el.hidden = false;
    scrim.hidden = false;
    if (focus) { el.scrollTop = 0; el.focus({ preventScroll: true }); }
  }

  // 空欄は「未入力」と出す
  const val = (x) => (x === '' || x == null ? '<span class="muted">未入力</span>' : esc(x));
  const guarantorText = (c, p) => (c.guarantor
    ? `${esc(c.guarantor)}${c.guarantorRelation ? `（${esc(c.guarantorRelation)}）` : ''}${p.guarantorGone ? ' <span class="bad">連絡不可</span>' : ''}`
    : 'なし');

  function customerCard(id) {
    const r = G.ledger(s).find((x) => x.c.id === id);
    if (!r) return '<p class="empty">見つかりません。</p>';
    const { c, p, loans } = r;
    const sched = G.schedule(s);
    const dues = [];
    for (const d of Object.keys(sched).map(Number).sort((a, b) => a - b)) {
      for (const e of sched[d]) if (e.customer.id === id) dues.push({ d, e });
    }
    const txs = s.txs.filter((t) => t.customerId === id && t.type !== 'accrue').reverse();
    const emergency = c.emergency.filter((e) => e.name || e.relation || e.contact);
    const visit = s.visitor === id ? '<span class="ok">来店中</span>' : p.nextVisit ? dayLink(p.nextVisit) : '<span class="muted">未定</span>';
    const del = G.canDeleteCustomer(s, id);
    return `
      <header class="drawer-h">
        <div><span class="no">顧客カルテ ・ No.${esc(c.id)}</span><h2>${esc(c.name)}<small>${esc(c.kana)}</small></h2></div>
        ${badge(r.status)}
        ${c.deleted ? '' : `<button class="ghost small" data-act="cust-edit" data-id="${esc(c.id)}">編集</button>`}
        <button class="close" data-act="close-drawer" aria-label="閉じる">×</button>
      </header>
      ${c.deleted ? `<p class="verdict warn">台帳から外した客です。取引の記録だけ残しています。<button class="link" data-act="cust-restore" data-id="${esc(c.id)}">台帳に戻す</button></p>` : ''}
      <div class="stat-row three tight">
        <div class="stat"><span>貸付残高</span><b>${yen(r.balance)}</b></div>
        <div class="stat"><span>未払いジャンプ金</span><b>${yen(r.accrued)}</b></div>
        <div class="stat"><span>次回期日</span><b>${r.nextDue ? dayLink(r.nextDue) : r.status === '延滞' ? '<span class="bad">延滞中</span>' : r.status === '夜逃げ' ? '<span class="bad">連絡不通</span>' : '—'}</b></div>
        <div class="stat"><span>ジャンプ金累計</span><b class="in">${yen(r.interestPaid)}</b></div>
        <div class="stat"><span>回収済元金</span><b>${yen(r.principalBack)}</b></div>
        <div class="stat"><span>ジャンプ回数</span><b>${r.jumps}回</b></div>
      </div>
      ${collectedLine(r.interestPaid, r.principalBack)}
      <h3 class="sec">基本情報</h3>
      <dl class="facts">
        <dt>年齢・職業</dt><dd>${c.age}歳・${val(c.job)}</dd>
        <dt>現住所</dt><dd>${val(c.address)}</dd>
        <dt>実家の住所</dt><dd>${val(c.homeAddress)}</dd>
        <dt>実家の連絡先</dt><dd>${val(c.homeContact)}</dd>
        <dt>流入元</dt><dd>${c.source ? esc(G.sourceText(c)) : val('')}</dd>
        <dt>来店回数</dt><dd>${p.visits}回</dd>
        <dt>次の来店予定</dt><dd>${visit}</dd>
      </dl>
      <h3 class="sec">申告と希望</h3>
      <dl class="facts">
        <dt>月収（申告）</dt><dd>${yen(c.declaredIncome)}</dd>
        <dt>希望額</dt><dd>${yen(p.want)}</dd>
        <dt>申告した理由</dt><dd>${val(c.claimReason)}</dd>
        <dt>担保</dt><dd>${val(c.collateral)}</dd>
      </dl>
      <h3 class="sec">勤務先</h3>
      <dl class="facts">
        <dt>勤務先名</dt><dd>${val(c.workName)}</dd>
        <dt>電話番号</dt><dd>${val(c.workPhone)}</dd>
        <dt>所在地</dt><dd>${val(c.workAddress)}</dd>
        <dt>勤務時間</dt><dd>${val(c.workHours)}</dd>
        <dt>休日</dt><dd>${val(c.workHoliday)}</dd>
        <dt>給料日</dt><dd>${val(c.payday)}</dd>
      </dl>
      <h3 class="sec">保証人</h3>
      <dl class="facts">
        <dt>氏名（関係）</dt><dd>${guarantorText(c, p)}</dd>
        ${c.guarantor ? `<dt>連絡先</dt><dd>${val(c.guarantorContact)}</dd>` : ''}
      </dl>
      <h3 class="sec">緊急連絡先 <span class="sub">${emergency.length}/${G.EMERGENCY_ROWS}名</span></h3>
      ${emergency.length ? `<div class="table-wrap"><table class="data compact">
        <thead><tr><th>氏名</th><th>関係</th><th>連絡先</th></tr></thead>
        <tbody>${emergency.map((e) => `<tr><td>${val(e.name)}</td><td>${val(e.relation)}</td><td class="wrap">${val(e.contact)}</td></tr>`).join('')}</tbody>
      </table></div>` : '<p class="empty">まだ登録がありません。「編集」から3名まで登録できます。</p>'}
      <h3 class="sec">調査情報</h3>
      ${p.investigated ? `<dl class="facts">
        <dt>本当の月収</dt><dd class="truth">${yen(c.income)}</dd>
        <dt>本当の理由</dt><dd class="truth">${esc(c.realReason)}</dd>
        <dt>弱み</dt><dd>${esc(c.weak)}<small>（${esc(c.weakType)}に弱い）</small></dd>
        <dt>逃げ足</dt><dd>${stars(c.nige)}</dd>
        <dt>ウソつき度</dt><dd>${stars(c.uso)}</dd>
        <dt>隠し資産</dt><dd>${esc(c.hidden)}${p.hiddenUsed ? ' <span class="muted">（回収済み）</span>' : ''}</dd>
        <dt>口癖</dt><dd>「${esc(c.kuchiguse)}」</dd>
      </dl>` : '<p class="empty">未調査です。身辺調査は、この客が来店したときに受付でできます。</p>'}
      <h3 class="sec">貸付</h3>
      ${loans.length ? `<div class="table-wrap"><table class="data compact">
        <thead><tr><th>貸付No</th><th>条件</th><th class="num">元金</th><th class="num">元金残高</th><th class="num">ジャンプ金累計</th><th class="num">回収済元金</th><th>状態</th></tr></thead>
        <tbody>${loans.map((l) => `<tr class="clickable" ${rowAttrs('open-loan', l.id)}>
          <td>No.${l.id}<span class="sub">${G.fmtDay(l.lentDay)}</span></td><td>${termsCell(l)}</td>
          <td class="num">${yen(l.lent)}</td><td class="num">${yen(l.principal)}</td>
          <td class="num in">${yen(l.interestPaid)}</td><td class="num">${yen(l.lent - l.principal)}</td><td>${badge(l.status)}</td></tr>`).join('')}</tbody>
      </table></div>` : '<p class="empty">まだ貸付はありません。</p>'}
      <h3 class="sec">支払い予定</h3>
      ${dues.length ? `<ul class="plain">${dues.slice(0, 8).map(({ d, e }) =>
        `<li>${dayLink(d)} ${loanLink(e.loan)} ジャンプ金 <b>${yen(e.jump)}</b>（完済なら${yen(e.payoff)}）</li>`).join('')}</ul>
        ${dues.length > 8 ? `<p class="help">ほか${dues.length - 8}回の予定があります。全部は貸付詳細かカレンダーで確認できます。</p>` : ''}`
        : `<p class="empty">最終日${lastDay()}までの支払い予定はありません。</p>`}
      <h3 class="sec">取引履歴</h3>
      ${txs.length ? `<div class="table-wrap"><table class="data compact">
        <thead><tr><th>日付</th><th>貸付</th><th>内訳</th><th class="num">金額</th><th class="num">元金残高</th></tr></thead>
        <tbody>${txs.map((t) => `<tr class="tx-${t.type}"><td>${dayLink(t.day)}</td><td>${loanLink(G.loanOf(s, t.loanId))}</td><td>${esc(txSummary(t))}</td>
          <td class="num">${txAmount(t)}</td><td class="num">${num(t.principal)}</td></tr>`).join('')}</tbody>
      </table></div>` : '<p class="empty">取引はまだありません。</p>'}
      <h3 class="sec">メモ <span class="sub" id="memo-state"></span></h3>
      <textarea id="memo" data-id="${esc(c.id)}" rows="4" placeholder="気づいたことを書いておけます（自動で保存）">${esc(p.memo || '')}</textarea>
      ${c.deleted ? '' : `<p class="actions danger-zone">
        <button class="ghost danger" data-act="cust-delete" data-id="${esc(c.id)}" ${del.ok ? '' : `disabled title="${esc(del.reason)}"`}>${del.ok && del.keepsRecord ? '台帳から外す' : 'この顧客を削除'}</button>
        <span class="help">${del.ok ? (del.keepsRecord ? '取引の記録がある客は、台帳から外すだけで記録は残ります。' : 'カルテの内容ごと削除します。') : esc(del.reason)}</span></p>`}`;
  }

  // ---- 顧客カルテの編集・追加 ----

  function customerForm(id) {
    const isNew = !id;
    const c = isNew ? null : G.customerOf(s, id);
    if (!isNew && !c) return '<p class="empty">見つかりません。</p>';
    const p = c ? s.people[c.id] : null;
    const v = (k, def) => (c ? c[k] : def);
    const F = { ...G.PROFILE, ...G.SECRET };
    const field = (k, opts = {}) => {
      const spec = F[k], value = opts.value !== undefined ? opts.value : v(k, opts.def !== undefined ? opts.def : '');
      const label = opts.label || spec.label;
      const control = spec.kind === 'select'
        ? `<select id="cf-${k}" name="${k}">${spec.options.map((o) => `<option value="${esc(o)}" ${o === value ? 'selected' : ''}>${esc(o || '未入力')}</option>`).join('')}</select>`
        : spec.kind === 'text'
          ? `<input id="cf-${k}" name="${k}" class="text-input" type="text" maxlength="${spec.max}" value="${esc(value)}" ${opts.list ? `list="${opts.list}"` : ''} ${opts.placeholder ? `placeholder="${esc(opts.placeholder)}"` : ''} ${spec.required ? 'required' : ''}>`
          : `<span class="unit-input"><input id="cf-${k}" name="${k}" type="number" min="${spec.min}" max="${spec.max}" step="${spec.kind === 'yen' ? 1000 : 1}" value="${esc(value)}"><span>${spec.kind === 'yen' ? '円' : k === 'age' ? '歳' : ''}</span></span>`;
      return `<div class="field ${opts.wide ? 'wide' : ''} ${opts.dim ? 'dim' : ''}"><label for="cf-${k}">${esc(label)}${spec.required ? ' <span class="bad">*</span>' : ''}</label>${control}${opts.help ? `<p class="help">${opts.help}</p>` : ''}</div>`;
    };
    const em = (c ? c.emergency : []).concat([{}, {}, {}]).slice(0, G.EMERGENCY_ROWS);
    const emRows = em.map((e, i) => `<div class="em-row"><span class="em-no">${i + 1}</span>
      <input name="em${i}_name" class="text-input" maxlength="40" placeholder="氏名" aria-label="緊急連絡先${i + 1}の氏名" value="${esc(e.name || '')}">
      <input name="em${i}_relation" class="text-input" maxlength="30" placeholder="関係（例：兄）" aria-label="緊急連絡先${i + 1}の関係" value="${esc(e.relation || '')}">
      <input name="em${i}_contact" class="text-input" maxlength="60" placeholder="連絡先（携帯番号など）" aria-label="緊急連絡先${i + 1}の連絡先" value="${esc(e.contact || '')}"></div>`).join('');
    const names = s.customers.filter((x) => !x.deleted && x.id !== id).map((x) => `<option value="${esc(x.name)}">`).join('');
    const visitDay = c ? (s.visitor === c.id ? s.day : p.nextVisit) : Math.min(s.day + 1, s.days);
    const secret = `
      <div class="grid2">
        ${field('income', { def: 200000 })}${field('realReason')}
        ${field('weakType', { def: '情', help: '情→泣き落とし、見栄→ご近所にあいさつ、家族→保証人に連絡が効く' })}${field('weak')}
        ${field('weakLine', { wide: true })}
        ${field('nige', { def: 3, help: '1〜5（5が逃げやすい）' })}${field('uso', { def: 1, help: '1〜5（5が大ウソつき）' })}
        ${field('hidden', { def: 'なし' })}${field('hiddenAmount', { def: 0 })}
        ${field('kuchiguse', { wide: true })}
      </div>`;
    return `
      <header class="drawer-h">
        <div><span class="no">${isNew ? `顧客の追加 ・ No.${String(s.nextCustomerNo).padStart(3, '0')}` : `顧客カルテの編集 ・ No.${esc(c.id)}`}</span><h2>${isNew ? '新しい顧客' : esc(c.name)}</h2></div>
        <button class="close" data-act="close-drawer" aria-label="閉じる">×</button>
      </header>
      <form id="cust-form" class="cust-form" novalidate>
        <h3 class="sec">基本情報</h3>
        <div class="grid2">
          ${field('name', { placeholder: '例：浪速 太郎' })}${field('kana', { placeholder: '例：なにわ たろう' })}
          ${field('age', { def: 30 })}${field('job')}
          ${field('address', { wide: true })}
          ${field('homeAddress', { wide: true })}
          ${field('homeContact', { placeholder: '例：06-xxxx-xxxx（母）' })}
        </div>
        <h3 class="sec">申告と希望</h3>
        <div class="grid2">
          ${field('declaredIncome', { def: 200000 })}${field('want', { value: c ? p.want : 100000 })}
          ${field('claimReason')}${field('collateral')}
        </div>
        <h3 class="sec">勤務先</h3>
        <div class="grid2">
          ${field('workName', { label: '勤務先名' })}${field('workPhone', { label: '電話番号' })}
          ${field('workAddress', { label: '所在地', wide: true })}
          ${field('workHours', { label: '勤務時間', placeholder: '例：9:00〜18:00' })}${field('workHoliday', { label: '休日', placeholder: '例：土日・祝日' })}
          ${field('payday', { label: '給料日', placeholder: '例：毎月25日' })}
        </div>
        <h3 class="sec">保証人</h3>
        <div class="grid2">
          ${field('guarantor', { label: '氏名', help: '空欄なら保証人なし（「保証人に連絡」は使えません）' })}${field('guarantorRelation', { label: '関係', placeholder: '例：母' })}
          ${field('guarantorContact', { label: '連絡先', placeholder: '携帯番号など', wide: true })}
          ${c ? `<label class="check wide"><input type="checkbox" name="guarantorGone" ${p.guarantorGone ? 'checked' : ''}> 保証人に連絡がつかない（「保証人に連絡」が使えなくなる）</label>` : ''}
        </div>
        <h3 class="sec">緊急連絡先 <span class="sub">3名まで</span></h3>
        <div class="em-rows">${emRows}</div>
        <h3 class="sec">流入元</h3>
        <div class="grid2">
          ${field('source', { label: 'どこから来たか' })}${field('referrer', { label: '紹介者名', list: 'cf-names', dim: v('source', '') !== '紹介', help: '流入元が「紹介」のとき' })}
          ${field('sourceNote', { label: '補足', wide: true, placeholder: '例：Xの広告を見て、DMで問い合わせ' })}
        </div>
        <datalist id="cf-names">${names}</datalist>
        <h3 class="sec">来店予定</h3>
        <div class="grid2">
          <div class="field"><label for="cf-nextVisit">次の来店予定日</label>
            <input id="cf-nextVisit" name="nextVisit" class="text-input" type="date" min="${G.isoOf(s.day)}" max="${G.isoOf(s.days)}" value="${visitDay ? G.isoOf(visitDay) : ''}">
            <p class="help">空欄なら未定。今日にすると、ほかに来店中の客がいなければすぐ来店します。</p></div>
        </div>
        <h3 class="sec">ゲームの設定（身辺調査で分かる本当の情報）</h3>
        ${isNew
          ? `<label class="check"><input type="checkbox" name="auto" checked> おまかせ（本当の月収・弱み・逃げ足などを自動で決める。身辺調査するまで分からない）</label>
             <div id="secret-fields" hidden>${secret}</div>`
          : `<details class="secret-box"><summary>開いて編集する（調査前の答えが見えます）</summary>${secret}</details>`}
        <div class="actions form-actions">
          <button type="submit" class="primary">${isNew ? 'この内容で追加する' : '保存する'}</button>
          <button type="button" class="ghost" data-act="cust-cancel">やめる</button>
        </div>
        <p class="error" id="cust-error" role="alert"></p>
      </form>`;
  }

  // 入力欄から内容を集めて保存する。まちがいがあれば、入力を残したまま知らせる
  function saveCustomerForm(formEl) {
    const fd = new FormData(formEl);
    const data = {};
    for (const k of [...Object.keys(G.PROFILE), ...Object.keys(G.SECRET)]) if (fd.has(k)) data[k] = fd.get(k);
    data.emergency = [];
    for (let i = 0; i < G.EMERGENCY_ROWS; i++) data.emergency.push({ name: fd.get(`em${i}_name`), relation: fd.get(`em${i}_relation`), contact: fd.get(`em${i}_contact`) });
    if (formEl.querySelector('[name="guarantorGone"]')) data.guarantorGone = fd.has('guarantorGone');
    const nv = fd.get('nextVisit');
    data.nextVisit = nv ? G.dayOfIso(nv) : null;
    data.auto = fd.has('auto');
    try {
      if (ui.drawer.id) G.updateCustomer(s, ui.drawer.id, data);
      else ui.drawer.id = G.addCustomer(s, data).id;
    } catch (e) {
      if (!(e instanceof G.GameError)) throw e;
      $('#cust-error').textContent = e.message;
      toast(e.message);
      return;
    }
    toast(`${G.customerOf(s, ui.drawer.id).name}のカルテを保存しました`);
    ui.drawer = { kind: 'customer', id: ui.drawer.id };
    save();
    render();
    renderDrawer(true);
  }

  // ---- 最初から（顧客台帳を引き継ぐか選ぶ） ----

  function renderReset() {
    const box = $('#reset');
    if (!ui.reset || !s) { box.hidden = true; return; }
    const roster = G.rosterOf(s);
    $('#reset-body').innerHTML = `
      <h2>最初から</h2>
      <p>1日目からやり直します。今の進み具合（貸付・取引・業務日誌・損益）は消えます。顧客台帳はどうしますか？</p>
      <div class="choice">
        <button class="primary" data-act="reset-roster">今の顧客台帳で最初から</button>
        <span class="help">編集・追加した客をそのまま使います（${roster.length}名。台帳から外した客は除く）</span>
      </div>
      <div class="choice">
        <button class="ghost" data-act="reset-csv">customers.csv から読み直す</button>
        <span class="help">台帳ファイルの客に戻します。編集・追加した内容は消えます</span>
      </div>
      <p class="actions"><button class="ghost" data-act="reset-close">やめる</button></p>`;
    box.hidden = false;
  }

  function loanCard(id) {
    const l = G.loanOf(s, id);
    if (!l) return '<p class="empty">見つかりません。</p>';
    const c = G.customerOf(s, l.customerId);
    const sched = G.schedule(s);
    const plan = [];
    for (const d of Object.keys(sched).map(Number).sort((a, b) => a - b)) {
      for (const e of sched[d]) if (e.loan.id === id) plan.push({ d, e });
    }
    const txs = s.txs.filter((t) => t.loanId === id);
    // 通帳のように、入金のたびにジャンプ金累計と回収済元金を積み上げて見せる
    let cumJump = 0, cumPrin = 0;
    const passRows = txs.map((t) => {
      const isPay = G.TX[t.type].pay;
      if (isPay) { cumJump += t.toInterest; cumPrin += t.toPrincipal; }
      return `<tr class="tx-${t.type}"><td>${G.fmtDay(t.day)}</td><td>${esc(txSummary(t))}</td><td class="num">${txAmount(t)}</td>
        <td class="num">${isPay ? `<b class="in">${num(cumJump)}</b>` : ''}</td><td class="num">${isPay ? `<b>${num(cumPrin)}</b>` : ''}</td>
        <td class="num">${num(t.principal)}</td><td class="num">${num(t.accrued)}</td></tr>`;
    }).join('');
    return `
      <header class="drawer-h">
        <div><span class="no">貸付詳細 ・ No.${l.id}</span><h2>${custLink(c)}</h2></div>
        ${badge(l.status)}
        <button class="close" data-act="close-drawer" aria-label="閉じる">×</button>
      </header>
      <div class="stat-row three tight">
        <div class="stat"><span>元金残高</span><b>${yen(l.principal)}</b></div>
        <div class="stat"><span>未払いジャンプ金</span><b>${yen(l.accrued)}</b></div>
        ${l.status === '不渡り' ? `<div class="stat"><span>不渡り額（${G.fmtDay(l.fuwatariDay)}計上）</span><b class="bad">${yen(l.fuwatari)}</b></div>`
          : l.status === '夜逃げ' ? `<div class="stat"><span>不渡りの計上予定</span><b class="bad">${dayLink(G.fuwatariDayOf(s, l))}</b></div>`
          : G.isActive(l) ? `<div class="stat"><span>完済金額（次の期日）</span><b>${yen(G.owedOf(l) + G.nextJumpOf(l))}</b></div>`
          : `<div class="stat"><span>完済日</span><b>${l.closedDay ? dayLink(l.closedDay) : '—'}</b></div>`}
        <div class="stat"><span>ジャンプ金累計</span><b class="in">${yen(l.interestPaid)}</b></div>
        <div class="stat"><span>回収済元金</span><b>${yen(l.lent - l.principal)}</b></div>
        <div class="stat"><span>ジャンプ回数</span><b>${l.jumps}回</b></div>
      </div>
      ${collectedLine(l.interestPaid, l.lent - l.principal)}
      <h3 class="sec">契約条件</h3>
      <dl class="facts">
        <dt>受付表記</dt><dd><b>${esc(G.receiptOf(l))}</b></dd>
        <dt>貸付日</dt><dd>${dayLink(l.lentDay)}</dd>
        <dt>① 元金-完済金</dt><dd>${esc(G.notationOf(l.lent, l.payoff0))}<small>（元金 ${yen(l.lent)}・完済金 ${yen(l.payoff0)}・利息 ${yen(l.interest0)}＝${esc(rateNote(l))}）</small></dd>
        <dt>② S</dt><dd>${l.cycle}S<small>（2回目からの期日の間隔は${G.stepOf(l.cycle)}日・当日から換算）</small></dd>
        <dt>③ 初回の期日</dt><dd>${dayLink(l.firstDue)}<small>（貸付日を1日目として${l.firstDue - l.lentDay + 1}日目）</small></dd>
        <dt>④ 振込金額</dt><dd>${yen(l.transfer)}<small>（振込手数料 ${yen(l.fee)} は${G.fmtDay(l.lentDay)}に売上に計上）</small></dd>
        <dt>⑤ 振込先口座</dt><dd>${l.account ? esc(l.account) : '<span class="muted">未入力</span>'}</dd>
        <dt>次のジャンプ金</dt><dd>${G.isActive(l) ? `${yen(G.nextJumpOf(l))}<small>（元金残高 ${yen(l.principal)} × 利息${num(l.interest0)}/元金${num(l.lent)}）</small>` : '—'}</dd>
        <dt>年利換算</dt><dd>${pct(G.aprOf(l.rate, l.cycle))}<small>10日あたり${pct(G.per10(l.rate, l.cycle))}</small></dd>
        <dt>次回期日</dt><dd>${l.status === '返済中' ? dayLink(l.due) : l.status === '延滞' ? `<span class="bad">延滞${l.overdueDays}日</span>`
          : l.status === '夜逃げ' ? `<span class="bad">連絡不通</span><small>（${G.fmtDay(l.lateSince)}の期日から${G.lateDaysOf(s, l)}日遅れ）</small>` : '—'}</dd>
        ${l.closedDay ? `<dt>${l.status === '完済' ? '完済日' : '夜逃げした日'}</dt><dd>${dayLink(l.closedDay)}</dd>` : ''}
        ${l.fuwatariDay ? `<dt>不渡りに計上</dt><dd>${dayLink(l.fuwatariDay)}<small>（${G.closingOf(l.fuwatariDay)}の締め・元金${yen(l.fuwatari)}）</small></dd>` : ''}
      </dl>
      <h3 class="sec">返済予定（最終日${lastDay()}まで）</h3>
      ${plan.length ? `<div class="table-wrap"><table class="data compact">
        <thead><tr><th>期日</th><th class="num">ジャンプ金</th><th class="num">完済金額</th></tr></thead>
        <tbody>${plan.map(({ d, e }) => `<tr><td>${dayLink(d)}</td><td class="num">${yen(e.jump)}</td><td class="num">${yen(e.payoff)}</td></tr>`).join('')}</tbody>
      </table></div><p class="help">2回目以降は、ジャンプ金だけ入れ続けた場合の見込みです。元金を詰めれば、その分ジャンプ金も下がります。</p>`
        : `<p class="empty">${l.status === '延滞' ? `延滞中です。未払いジャンプ金 ${yen(l.accrued)} が満額そろえばジャンプ成立。次回の期日は元の予定どおり ${G.fmtDay(l.due)} です（払った日から数え直しません）。`
          : l.status === '夜逃げ' ? `夜逃げして連絡がつきません。期日（${G.fmtDay(l.lateSince)}）から2週間を過ぎた最初の締め（${G.fmtDay(G.fuwatariDayOf(s, l))}）で、元金 ${yen(l.principal)} を不渡りにして貸付総元金から引きます。`
          : l.status === '不渡り' ? `${G.fmtDay(l.fuwatariDay)}の締めで不渡りにしました。元金 ${yen(l.fuwatari)} は貸付総元金から引いてあります。`
          : `最終日${lastDay()}までの期日はありません。`}</p>`}
      <h3 class="sec">取引明細</h3>
      <div class="table-wrap"><table class="data compact passbook">
        <thead><tr><th>日付</th><th>内訳</th><th class="num">金額</th><th class="num">ジャンプ金累計</th><th class="num">回収済元金</th><th class="num">元金残高</th><th class="num">未払いジャンプ金</th></tr></thead>
        <tbody>${passRows}</tbody>
      </table></div>
      <p class="help">入金はジャンプ金（未払い分）に先に充当し、多い分で元金を詰めます。内訳の「ジャンプ(80,000)＋元金詰め(149,000)」は、80,000円をジャンプ金に、149,000円を元金に充てたという意味です。「ジャンプ金発生」は期日にジャンプ金が発生した記録で、お金は動いていません。</p>`;
  }

  // ---- 結果 ----

  function renderResult() {
    if (!s.over) { $('#result').hidden = true; return; }
    const t = G.totals(s), p = G.pl(s);
    const book = G.ledger(s);
    const count = (st) => s.loans.filter((l) => l.status === st).length;
    const carry = sum(s.loans.filter((l) => l.status === '延滞' || l.status === '夜逃げ'), (l) => l.principal);
    const rows = book.map(({ c, status, lent, interestPaid, principalBack, fuwatari }) => `<tr>
      <td>${esc(c.name)}</td><td>${badge(status)}</td>
      <td class="num">${lent ? yen(lent) : '—'}</td><td class="num in">${interestPaid ? yen(interestPaid) : '—'}</td><td class="num">${principalBack ? yen(principalBack) : '—'}</td>
      <td class="num ${fuwatari ? 'bad' : ''}">${fuwatari ? yen(fuwatari) : '—'}</td></tr>`).join('');
    $('#result-body').innerHTML = `
      <span class="big-stamp ${s.over.win ? 'win' : 'lose'}">${s.over.win ? '勝ち' : '負け'}</span>
      <h2>${esc(s.over.reason)}</h2>
      <dl class="summary">
        <div><dt>純利</dt><dd class="${p.net < 0 ? 'bad' : 'in'}">${signedYen(p.net)}</dd></div>
        <div><dt>総売上</dt><dd>${yen(p.sales)}</dd></div>
        <div><dt>経費</dt><dd>${yen(p.expenses)}</dd></div>
        <div><dt>不渡り</dt><dd>${yen(p.fuwatari)}</dd></div>
        <div><dt>貸付総元金（持ち越し）</dt><dd>${yen(t.balance)}</dd></div>
        <div><dt>完済 / 夜逃げ / 不渡り</dt><dd>${count('完済')} / ${count('夜逃げ')} / ${count('不渡り')}</dd></div>
      </dl>
      ${plLine(p)}
      ${carry ? `<p class="help">延滞・夜逃げのまま持ち越した元金 ${yen(carry)} は、まだ不渡りにしていないので純利から引いていません。</p>` : ''}
      <div class="table-wrap"><table class="data compact">
        <thead><tr><th>客</th><th>最後の状態</th><th class="num">貸した総額</th><th class="num">ジャンプ金累計</th><th class="num">回収済元金</th><th class="num">不渡り</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
      <p class="actions" style="margin-top:16px">
        ${s.over.byTime ? '<button class="primary" data-act="period-open">期間を延ばして続ける</button>' : ''}
        <button class="${s.over.byTime ? 'ghost' : 'primary'}" data-act="restart">もう一度（別の展開）</button>
        <button class="ghost" data-act="close-result">帳簿を見返す</button>
      </p>`;
    $('#result').hidden = !!ui.resultClosed;
  }

  // ---- 期間・目標 ----

  function renderPeriod() {
    const box = $('#period');
    if (!ui.period || !s) { box.hidden = true; return; }
    const extending = !!(s.over && s.over.byTime);
    const ends = G.closingDays(extending ? s.day + 1 : s.day, G.CONFIG.maxDays);
    if (!ends.includes(ui.period.end)) {
      // 選べない最終日（延ばすときの今の最終日など）は次の候補にずらす。目標が標準のままなら一緒に合わせる
      const wasStd = ui.period.goal === G.goalFor(ui.period.end);
      ui.period.end = ends.find((d) => d >= ui.period.end) || ends[0];
      if (wasStd) ui.period.goal = G.goalFor(ui.period.end);
    }
    const opts = ends.map((d) => `<option value="${d}" ${d === ui.period.end ? 'selected' : ''}>${G.fmtDayLong(d)}（${G.closingOf(d)}・${d}日）</option>`).join('');
    const std = G.goalFor(ui.period.end);
    $('#period-body').innerHTML = `
      <h2>期間・目標</h2>
      <dl class="facts">
        <dt>開始日</dt><dd>${G.fmtDayLong(1)}</dd>
        <dt>今日</dt><dd>${G.fmtDayLong(s.day)}（${s.day}日目）</dd>
        <dt>今の最終日</dt><dd>${G.fmtDayLong(s.days)}（${s.days}日）</dd>
        <dt>今の目標</dt><dd>純利 ${yen(s.goal)}</dd>
      </dl>
      <form id="period-form" class="terms" novalidate>
        <div class="field"><label for="period-end">最終日</label>
          <select id="period-end">${opts}</select>
          <p class="help">最終日は締め日（15日か月末）から選びます。最後の締めで不渡りを計上してから、純利で勝ち負けを決めるためです。</p></div>
        <div class="field"><label for="period-goal">目標の純利</label>
          <span class="unit-input"><input type="number" id="period-goal" min="1" step="100000" value="${Number.isFinite(ui.period.goal) ? ui.period.goal : ''}"><span>円</span></span>
          <p class="help">この期間の標準は${yen(std)}（1日あたり${yen(G.CONFIG.goalPerDay)}の目安）。<button type="button" class="link" data-act="period-std">標準にする</button></p></div>
        ${extending ? '<p class="verdict good">期間を延ばすと、いまの結果を取り消して営業を続けます。</p>' : ''}
        <div class="actions"><button type="submit" class="primary">${extending ? '延ばして続ける' : 'この期間と目標にする'}</button>
          <button type="button" class="ghost" data-act="period-close">やめる</button></div>
      </form>`;
    box.hidden = false;
  }

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act="close-result"]');
    if (el) { ui.resultClosed = true; $('#result').hidden = true; }
  });

  boot();
})();
