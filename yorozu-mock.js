// よろず相談：テストモード（URL に ?test を付けたときだけ使う）
// データはこの端末のブラウザの中だけ（localStorage）。Supabase にも Mattermost にも届かない。
// yorozu.sql の関数と同じ動きをまねている。
(function () {
  const KEY = 'yorozu_test_db_v1';
  const KINDS = [
    '医療保険に関すること',
    '介護保険・介護サービスに関すること',
    '訪問診療・通院が難しくなったこと',
    '有料老人ホーム・施設を探している',
    'ケアマネジャーを探している',
    'その他',
  ];
  let memory = null;

  function fresh() {
    return {
      seq: { case: 0, note: 0, staff: 2, log: 0 },
      staff: [
        { id: 1, name: '理事長', is_admin: true, active: true, mm_username: 'rijicho' },
        { id: 2, name: '春日', is_admin: false, active: true, mm_username: 'kasuga' },
      ],
      cases: [], notes: [], logs: [], mm: [], sessions: {},
    };
  }
  function load() {
    try { const s = localStorage.getItem(KEY); if (s) return JSON.parse(s); } catch (e) {}
    return memory || fresh();
  }
  function save(db) {
    memory = db;
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {}
  }
  const now = () => new Date().toISOString();
  const err = (m) => { throw new Error(m); };

  function adminUrl() {
    return location.pathname.replace(/[^/]*$/, '') + 'yorozu-admin.html?test';
  }
  function notify(db, text) { db.mm.push({ at: now(), text }); }
  function log(db, staff_id, action, case_id, detail) {
    db.logs.push({ id: ++db.seq.log, at: now(), staff_id, action, case_id, detail });
  }
  function staffName(db, id) { const s = db.staff.find(x => x.id === id); return s ? s.name : null; }
  function caseJson(db, c) {
    return Object.assign({}, c, {
      no: 'Y' + c.id,
      assignee: staffName(db, c.assignee_id),
      note_count: db.notes.filter(n => n.case_id === c.id).length,
    });
  }
  function auth(db, token) {
    const sid = db.sessions[token];
    const me = db.staff.find(s => s.id === sid && s.active);
    if (!me) { const e = new Error('ログインが切れました。もう一度入ってください'); e.code = 'P0401'; throw e; }
    return me;
  }
  function getCase(db, me, id, withLog) {
    const c = db.cases.find(x => x.id === id);
    if (!c) err('この相談は見つかりません（削除されたかもしれません）');
    if (withLog) log(db, me.id, '閲覧', id);
    return Object.assign(caseJson(db, c), {
      notes: db.notes.filter(n => n.case_id === id).map(n => ({ id: n.id, body: n.body, at: n.created_at, by: staffName(db, n.staff_id) })),
      history: db.logs.filter(l => l.case_id === id && l.action !== '閲覧').map(l => ({ at: l.at, action: l.action, detail: l.detail, by: staffName(db, l.staff_id) })),
    });
  }

  const fns = {
    yorozu_submit(db, { p }) {
      if (p.website) return { ok: true };
      const name = String(p.name || '').trim(), phone = String(p.phone || '').trim();
      if (!name) err('お名前を入れてください');
      const digits = phone.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[^0-9]/g, '');
      if (digits.length < 10) err('電話番号を確かめてください');
      const kinds = (p.kinds || []).filter(k => KINDS.includes(k));
      if (!kinds.length) err('ご相談の内容を1つ以上選んでください');
      const id = ++db.seq.case;
      db.cases.push({
        id, created_at: now(), name, phone, email: p.email || null, relation: p.relation || null, kinds,
        detail: p.detail || null, contact_method: p.contact_method || null, contact_time: p.contact_time || null,
        status: '未対応', assignee_id: null, updated_at: now(), done_at: null, pattern: p.pattern || null,
      });
      notify(db, '#### 📮 よろず相談室に新しい相談が届きました（Y' + id + '）\n種類：' + kinds.join('、') + '\n[管理画面で見る](' + adminUrl() + '#Y' + id + ')');
      return { ok: true, no: 'Y' + id };
    },
    yorozu_login(db, { p_pin, p_staff_id }) {
      const me = db.staff.find(s => s.active && (s.id === p_staff_id));
      if (!me) return { error: 'テストモードでは、下のボタンで入ってください' };
      const token = 'test-' + Math.random().toString(36).slice(2);
      db.sessions[token] = me.id;
      return { token, id: me.id, name: me.name, is_admin: me.is_admin };
    },
    yorozu_logout(db, { p_token }) { delete db.sessions[p_token]; return { ok: true }; },
    yorozu_list(db, { p_token }) {
      const me = auth(db, p_token);
      return {
        me: { id: me.id, name: me.name, is_admin: me.is_admin },
        kinds: KINDS,
        staff: db.staff.filter(s => s.active).map(s => ({ id: s.id, name: s.name })),
        cases: db.cases.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)).map(c => caseJson(db, c)),
      };
    },
    yorozu_get(db, { p_token, p_id }) { const me = auth(db, p_token); return getCase(db, me, p_id, true); },
    yorozu_update(db, { p_token, p_id, p_status, p_assignee_id }) {
      const me = auth(db, p_token);
      const c = db.cases.find(x => x.id === p_id); if (!c) err('この相談は見つかりません');
      if (!['未対応', '対応中', '完了'].includes(p_status)) err('状況の値がちがいます');
      let asg = null;
      if (p_assignee_id != null) { asg = db.staff.find(s => s.id === p_assignee_id && s.active); if (!asg) err('その担当者は選べません'); }
      const old = Object.assign({}, c);
      c.status = p_status; c.assignee_id = p_assignee_id; c.updated_at = now();
      c.done_at = p_status === '完了' ? (c.done_at || now()) : null;
      if (old.status !== p_status) log(db, me.id, '状況', p_id, old.status + ' → ' + p_status);
      if (old.assignee_id !== p_assignee_id) {
        log(db, me.id, '担当', p_id, asg ? asg.name : '（なし）');
        if (asg && asg.id !== me.id) {
          notify(db, '📮 よろず相談室 Y' + p_id + ' の担当になりました：' + (asg.mm_username ? '@' + asg.mm_username : asg.name + ' さん') +
            '（' + me.name + ' さんより）\n[管理画面で見る](' + adminUrl() + '#Y' + p_id + ')');
        }
      }
      return getCase(db, me, p_id, false);
    },
    yorozu_add_note(db, { p_token, p_id, p_body }) {
      const me = auth(db, p_token);
      const body = String(p_body || '').trim(); if (!body) err('メモが空です');
      const c = db.cases.find(x => x.id === p_id); if (!c) err('この相談は見つかりません');
      db.notes.push({ id: ++db.seq.note, case_id: p_id, staff_id: me.id, body, created_at: now() });
      c.updated_at = now(); if (c.status === '未対応') c.status = '対応中';
      return getCase(db, me, p_id, false);
    },
    yorozu_delete(db, { p_token, p_id }) {
      const me = auth(db, p_token);
      if (!me.is_admin) err('削除できるのは管理者だけです');
      db.cases = db.cases.filter(c => c.id !== p_id);
      db.notes = db.notes.filter(n => n.case_id !== p_id);
      log(db, me.id, '削除', p_id);
      return { ok: true };
    },
    yorozu_staff_list(db, { p_token }) {
      const me = auth(db, p_token);
      if (!me.is_admin) err('管理者だけが使えます');
      return db.staff.slice().sort((a, b) => (b.active - a.active) || (a.id - b.id));
    },
    yorozu_staff_save(db, { p_token, p }) {
      const me = auth(db, p_token);
      if (!me.is_admin) err('管理者だけが使えます');
      const name = String(p.name || '').trim(); if (!name) err('名前を入れてください');
      const mm = String(p.mm_username || '').replace(/^[\s@]+|\s+$/g, '').toLowerCase() || null;
      const pin = () => String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
      if (!p.id) {
        const s = { id: ++db.seq.staff, name, is_admin: !!p.is_admin, active: true, mm_username: mm };
        db.staff.push(s);
        return { ok: true, id: s.id, name, pin: pin() };
      }
      const s = db.staff.find(x => x.id === p.id); if (!s) err('見つかりません');
      if (s.id === me.id && (!p.is_admin || p.active === false)) err('自分の管理者の印・有効は外せません（ほかの管理者に頼んでください）');
      Object.assign(s, { name, is_admin: !!p.is_admin, active: p.active !== false, mm_username: mm });
      if (!s.active) for (const t in db.sessions) if (db.sessions[t] === s.id) delete db.sessions[t];
      return { ok: true, id: s.id, name, pin: p.reset_pin ? pin() : null };
    },
  };

  window.YorozuMock = {
    call(fn, args) {
      const db = load();
      if (!fns[fn]) return Promise.reject(new Error('テストモードにない機能です：' + fn));
      try { const r = fns[fn](db, args || {}); save(db); return Promise.resolve(JSON.parse(JSON.stringify(r))); }
      catch (e) { return Promise.reject(e); }
    },
    staff() { return load().staff.filter(s => s.active); },
    mm() { return load().mm.slice().reverse(); },
    reset() { save(fresh()); },
    seed() {
      const db = load();
      const samples = [
        ['新垣 和子', '090-1111-2222', ['訪問診療・通院が難しくなったこと'], '母（88歳）が歩くのが大変になり、通院がむずかしくなってきました。家に来てもらえる先生を探しています。', 'ご家族', '電話', '平日の夕方'],
        ['宮城 健一', '098-333-4444', ['介護保険・介護サービスに関すること', 'ケアマネジャーを探している'], '父の介護認定の申し込みのしかたが分かりません。', 'ご家族', 'どちらでもよい', ''],
        ['照屋 光子', '080-5555-6666', ['有料老人ホーム・施設を探している'], '一人暮らしが不安なので、入れる施設を探しています。費用も知りたいです。', 'ご本人', '電話', '午前中'],
        ['仲村 誠', '090-7777-8888', ['医療保険に関すること'], '医療費の上限の制度について知りたい。', 'ご本人', 'メール', ''],
        ['比嘉 美代', '098-999-0000', ['その他'], '近所の高齢の方のことで相談したいです。', 'その他', '電話', '平日'],
      ];
      samples.forEach((s, i) => {
        const id = ++db.seq.case;
        const t = new Date(Date.now() - (samples.length - i) * 3600e3 * 7).toISOString();
        db.cases.push({ id, created_at: t, name: s[0], phone: s[1], email: s[5] === 'メール' ? 'sample@example.com' : null, relation: s[4], kinds: s[2],
          detail: s[3], contact_method: s[5], contact_time: s[6] || null, status: i < 2 ? '対応中' : '未対応',
          assignee_id: i < 2 ? 2 : null, updated_at: t, done_at: null });
        if (i === 0) db.notes.push({ id: ++db.seq.note, case_id: id, staff_id: 2, body: '電話しました。訪問診療の流れを説明。来週、先生と訪問予定。', created_at: t });
      });
      save(db);
    },
  };
})();
