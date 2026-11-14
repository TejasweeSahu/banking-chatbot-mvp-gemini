/**
 * Deterministic demo seed. Generates ~6 months of realistic history relative
 * to an anchor date using a seeded PRNG, so the same anchor always yields the
 * same ledger. Balances are derived from the generated ledger, never typed in.
 *
 * Built-in demo scenarios (all in the current month):
 *  - two saved beneficiaries named "Rahul" (ambiguity resolution)
 *  - a duplicate-looking Swiggy charge, a failed-then-retried UPI payment,
 *    a pending UPI payment, a merchant refund, an unusually large purchase,
 *    and a newly started subscription.
 */

import { addDays, addMonths, daysInMonth, monthStart, parseIso, today } from '../lib/dates.js';
import { hashPassword } from '../lib/password.js';

export const DEMO_PASSWORD = 'Northstar@2026';

export const CATEGORIES = [
  ['food', 'Food & dining', 'expense', '#e07a5f'],
  ['groceries', 'Groceries', 'expense', '#81b29a'],
  ['transport', 'Transport', 'expense', '#3d5a80'],
  ['shopping', 'Shopping', 'expense', '#9c6ade'],
  ['bills', 'Bills & utilities', 'expense', '#f2cc8f'],
  ['subscriptions', 'Subscriptions', 'expense', '#5fa8d3'],
  ['entertainment', 'Entertainment', 'expense', '#ef8354'],
  ['health', 'Health', 'expense', '#52b788'],
  ['travel', 'Travel', 'expense', '#4f6d7a'],
  ['rent', 'Rent & housing', 'expense', '#8d99ae'],
  ['investments', 'Investments', 'investment', '#2a9d8f'],
  ['transfers', 'Transfers', 'transfer', '#6c757d'],
  ['income', 'Income', 'income', '#2d6a4f'],
  ['refunds', 'Refunds', 'income', '#40916c']
];

let cachedHash = null;
const demoHash = () => (cachedHash ??= hashPassword(DEMO_PASSWORD));

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function isSeeded(db) {
  return Boolean(db.get('SELECT 1 AS ok FROM users LIMIT 1'));
}

export function seedDatabase(db, { anchor = today() } = {}) {
  const rng = mulberry32(20261114);
  const int = (min, max) => min + Math.floor(rng() * (max - min + 1));
  const pick = (items) => items[Math.floor(rng() * items.length)];
  const rupees = (min, max) => int(min, max) * 100; // whole-rupee amounts in paise
  const created = `${anchor}T00:00:00.000Z`;
  const historyStart = addMonths(monthStart(anchor), -5);

  db.transaction(() => {
    for (const [id, label, kind, color] of CATEGORIES) {
      db.run('INSERT INTO categories (id, label, kind, color) VALUES (:id, :label, :kind, :color)', { id, label, kind, color });
    }

    const users = [
      { id: 'usr_tejas', username: 'tejas', full_name: 'Tejas', email: 'tejas@example.com', role: 'customer' },
      { id: 'usr_aisha', username: 'aisha', full_name: 'Aisha Khan', email: 'aisha@example.com', role: 'customer' },
      { id: 'usr_meera', username: 'meera', full_name: 'Meera Iyer', email: 'meera@example.com', role: 'viewer' }
    ];
    for (const u of users) {
      db.run(`INSERT INTO users (id, username, full_name, email, password_hash, role, created_at)
              VALUES (:id, :username, :full_name, :email, :hash, :role, :created)`, { ...u, hash: demoHash(), created });
    }

    const accounts = [
      { id: 'acc_tejas_sav', user_id: 'usr_tejas', type: 'savings', nickname: 'Everyday Savings', account_number: '30881209372048', ifsc: 'NSTR0000142', branch: 'Bhubaneswar Main', opening: 4_235_075, primary: 1, rate: 300, opened: '2021-06-14', maturity: null },
      { id: 'acc_tejas_fam', user_id: 'usr_tejas', type: 'savings', nickname: 'Family Savings', account_number: '30881209375531', ifsc: 'NSTR0000142', branch: 'Bhubaneswar Main', opening: 15_000_000, primary: 0, rate: 350, opened: '2022-01-03', maturity: null },
      { id: 'acc_tejas_fd', user_id: 'usr_tejas', type: 'fixed_deposit', nickname: 'Fixed Deposit', account_number: '30881209379902', ifsc: 'NSTR0000142', branch: 'Bhubaneswar Main', opening: 30_000_000, primary: 0, rate: 710, opened: addMonths(anchor, -10), maturity: addMonths(anchor, 14) },
      { id: 'acc_aisha_sav', user_id: 'usr_aisha', type: 'savings', nickname: 'Savings', account_number: '30881209447731', ifsc: 'NSTR0000108', branch: 'Pune Camp', opening: 8_500_000, primary: 1, rate: 300, opened: '2020-09-21', maturity: null },
      { id: 'acc_meera_sav', user_id: 'usr_meera', type: 'savings', nickname: 'Savings', account_number: '30881209516604', ifsc: 'NSTR0000077', branch: 'Chennai Adyar', opening: 2_400_000, primary: 1, rate: 300, opened: '2023-02-11', maturity: null }
    ];

    const ledger = new Map(accounts.map((a) => [a.id, a.opening]));
    const transactions = [];
    let seq = 0;
    const ref = (channel) => {
      seq += 1;
      const n = String(int(100000, 999999)) + String(seq).padStart(6, '0');
      return ({ upi: 'UPI', card: 'POS', neft: 'NEFT', imps: 'IMPS', rtgs: 'RTGS', netbanking: 'NB', auto_debit: 'ACH', atm: 'ATM', internal: 'INT' })[channel] + n;
    };
    const add = (t) => {
      if (t.date > anchor || t.date < historyStart) return null;
      const id = `txn_${String(transactions.length + 1).padStart(5, '0')}`;
      const time = t.time ?? `${String(int(8, 22)).padStart(2, '0')}:${String(int(0, 59)).padStart(2, '0')}`;
      const row = {
        id,
        user_id: t.user ?? 'usr_tejas',
        account_id: t.account ?? 'acc_tejas_sav',
        date: t.date,
        posted_at: `${t.date}T${time}:00.000Z`,
        description: t.description,
        merchant: t.merchant,
        category_id: t.category,
        direction: t.direction ?? 'debit',
        amount_paise: t.amount,
        status: t.status ?? 'success',
        channel: t.channel,
        reference: ref(t.channel),
        failure_reason: t.failure ?? null,
        created_at: `${t.date}T${time}:00.000Z`
      };
      transactions.push(row);
      if (row.status === 'success') {
        ledger.set(row.account_id, ledger.get(row.account_id) + (row.direction === 'credit' ? row.amount_paise : -row.amount_paise));
      }
      return row;
    };
    const dayIn = (mStart, day) => {
      const d = parseIso(mStart);
      return `${mStart.slice(0, 8)}${String(Math.min(day, daysInMonth(d.getUTCFullYear(), d.getUTCMonth()))).padStart(2, '0')}`;
    };

    const anchorDay = Number(anchor.slice(8, 10));
    const currentMonth = monthStart(anchor);
    let flipkartReturn = null;

    for (let m = -5; m <= 0; m += 1) {
      const ms = addMonths(currentMonth, m);
      const isCurrent = m === 0;
      const lastDay = isCurrent ? anchorDay : daysInMonth(parseIso(ms).getUTCFullYear(), parseIso(ms).getUTCMonth());
      const randDay = () => int(1, lastDay);

      add({ date: dayIn(ms, 1), time: '06:05', description: 'Salary credit — ACME Technologies Pvt Ltd', merchant: 'ACME Technologies', category: 'income', direction: 'credit', amount: 9_500_000, channel: 'neft' });
      add({ date: dayIn(ms, 2), time: '07:00', description: 'Airtel Xstream Fiber autopay', merchant: 'Airtel', category: 'bills', amount: 79_900, channel: 'auto_debit' });
      add({ date: dayIn(ms, 3), time: '09:30', description: 'Rent — standing instruction to Anil Kapoor', merchant: 'Anil Kapoor', category: 'rent', amount: 2_200_000, channel: 'neft' });
      add({ date: dayIn(ms, 5), time: '10:00', description: 'SIP — Axis Bluechip Fund', merchant: 'Axis Mutual Fund', category: 'investments', amount: 500_000, channel: 'auto_debit' });
      const fam = add({ date: dayIn(ms, 6), time: '10:15', description: 'Transfer to Family Savings ••5531', merchant: 'Family Savings', category: 'transfers', amount: 1_000_000, channel: 'internal' });
      if (fam) add({ date: fam.date, time: '10:15', account: 'acc_tejas_fam', description: 'Transfer from Everyday Savings ••2048', merchant: 'Everyday Savings', category: 'transfers', direction: 'credit', amount: 1_000_000, channel: 'internal' });
      add({ date: dayIn(ms, 7), time: '06:30', description: 'Cult.fit membership', merchant: 'Cult.fit', category: 'subscriptions', amount: 150_000, channel: 'card' });
      add({ date: dayIn(ms, 12), time: '05:10', description: 'Netflix subscription', merchant: 'Netflix', category: 'subscriptions', amount: 64_900, channel: 'card' });
      add({ date: dayIn(ms, 18), time: '05:12', description: 'Spotify Premium', merchant: 'Spotify', category: 'subscriptions', amount: 11_900, channel: 'card' });
      if (!isCurrent) {
        add({ date: dayIn(ms, 10), description: 'TPCODL electricity bill', merchant: 'TPCODL', category: 'bills', amount: rupees(900, 1700), channel: 'netbanking' });
        add({ date: dayIn(ms, 20), description: 'Jio Postpaid bill', merchant: 'Jio', category: 'bills', amount: 59_900, channel: 'upi' });
      }
      if (m % 3 === 0) add({ date: dayIn(ms, 28), time: '04:00', account: 'acc_tejas_fam', description: 'Quarterly interest credit', merchant: 'Northstar Bank', category: 'income', direction: 'credit', amount: rupees(1200, 1400), channel: 'internal' });

      // Variable spending, scaled to the elapsed part of the month.
      const scale = lastDay / 30;
      const times = (n) => Math.max(0, Math.round(n * scale));
      for (let i = 0; i < times(int(9, 13)); i += 1) {
        const merchant = pick(['Swiggy', 'Zomato']);
        add({ date: dayIn(ms, randDay()), description: `${merchant} order`, merchant, category: 'food', amount: rupees(180, 720), channel: 'upi' });
      }
      for (let i = 0; i < times(3); i += 1) {
        const merchant = pick(['Starbucks', 'Third Wave Coffee', 'Cafe Coffee Day']);
        add({ date: dayIn(ms, randDay()), description: merchant, merchant, category: 'food', amount: rupees(220, 480), channel: 'card' });
      }
      for (let i = 0; i < times(4); i += 1) {
        const merchant = pick(['BigBasket', 'Reliance Fresh', 'DMart', 'Zepto']);
        add({ date: dayIn(ms, randDay()), description: `${merchant} groceries`, merchant, category: 'groceries', amount: rupees(650, 2600), channel: pick(['upi', 'card']) });
      }
      for (let i = 0; i < times(int(6, 9)); i += 1) {
        const merchant = pick(['Uber', 'Ola', 'Rapido']);
        add({ date: dayIn(ms, randDay()), description: `${merchant} ride`, merchant, category: 'transport', amount: rupees(90, 620), channel: 'upi' });
      }
      for (let i = 0; i < times(2); i += 1) {
        add({ date: dayIn(ms, randDay()), description: 'Indian Oil fuel', merchant: 'Indian Oil', category: 'transport', amount: rupees(1500, 2400), channel: 'card' });
      }
      for (let i = 0; i < times(3); i += 1) {
        const merchant = pick(['Amazon', 'Myntra', 'Flipkart', 'Decathlon']);
        const row = add({ date: dayIn(ms, randDay()), description: `${merchant} purchase`, merchant, category: 'shopping', amount: rupees(399, 3999), channel: 'card' });
        if (m === -1 && merchant === 'Flipkart' && row && !flipkartReturn) flipkartReturn = row;
      }
      if (rng() < 0.8) {
        const merchant = pick(['BookMyShow', 'PVR Cinemas']);
        add({ date: dayIn(ms, randDay()), description: `${merchant} tickets`, merchant, category: 'entertainment', amount: rupees(350, 1100), channel: 'upi' });
      }
      if (rng() < 0.7) add({ date: dayIn(ms, randDay()), description: 'Apollo Pharmacy', merchant: 'Apollo Pharmacy', category: 'health', amount: rupees(250, 900), channel: 'card' });
      if (m % 2 === 0 && !isCurrent) {
        add({ date: dayIn(ms, int(14, 26)), description: 'IMPS to Priya Nair', merchant: 'Priya Nair', category: 'transfers', amount: rupees(1500, 4000), channel: 'imps' });
      }
    }

    // Guarantee a Flipkart purchase last month for the refund complaint scenario.
    if (!flipkartReturn) {
      flipkartReturn = add({ date: dayIn(addMonths(currentMonth, -1), 21), description: 'Flipkart purchase', merchant: 'Flipkart', category: 'shopping', amount: 219_900, channel: 'card' });
    }

    // Current-month scenarios. Days are clamped into the elapsed part of the month.
    const d = (offset) => {
      const day = Math.max(1, Math.min(anchorDay, anchorDay - offset));
      return dayIn(currentMonth, day);
    };
    add({ date: d(6), time: '18:40', description: 'Croma — Sony WF-1000XM5 earbuds', merchant: 'Croma', category: 'shopping', amount: 1_499_000, channel: 'card' });
    add({ date: d(5), time: '21:05', description: 'IndiGo flight BBI → BLR', merchant: 'IndiGo', category: 'travel', amount: 645_000, channel: 'card' });
    add({ date: d(5), time: '07:00', description: 'Disney+ Hotstar subscription', merchant: 'Disney+ Hotstar', category: 'subscriptions', amount: 29_900, channel: 'card' });
    add({ date: d(4), time: '20:30', description: 'Barbeque Nation dinner', merchant: 'Barbeque Nation', category: 'food', amount: 324_000, channel: 'card' });
    add({ date: d(4), time: '11:20', description: 'Refund — Myntra order return', merchant: 'Myntra', category: 'refunds', direction: 'credit', amount: 129_900, channel: 'card' });
    add({ date: d(3), time: '13:02', description: 'UPI payment to Sharma Kirana Store', merchant: 'Sharma Kirana Store', category: 'groceries', amount: 120_000, channel: 'upi', status: 'failed', failure: 'Beneficiary bank did not respond (timeout). No money was debited.' });
    add({ date: d(3), time: '13:07', description: 'UPI payment to Sharma Kirana Store', merchant: 'Sharma Kirana Store', category: 'groceries', amount: 120_000, channel: 'upi' });
    add({ date: d(2), time: '20:14', description: 'Swiggy order', merchant: 'Swiggy', category: 'food', amount: 48_600, channel: 'upi' });
    add({ date: d(2), time: '20:15', description: 'Swiggy order', merchant: 'Swiggy', category: 'food', amount: 48_600, channel: 'upi' });
    add({ date: d(1), time: '16:45', description: 'UPI payment to Urban Company', merchant: 'Urban Company', category: 'bills', amount: 235_000, channel: 'upi', status: 'pending' });

    // Other customers (authorization boundaries).
    add({ user: 'usr_aisha', account: 'acc_aisha_sav', date: dayIn(currentMonth, 1), description: 'Salary credit — Globex Ltd', merchant: 'Globex', category: 'income', direction: 'credit', amount: 11_000_000, channel: 'neft' });
    add({ user: 'usr_aisha', account: 'acc_aisha_sav', date: d(2), description: 'Zomato order', merchant: 'Zomato', category: 'food', amount: 61_000, channel: 'upi' });
    add({ user: 'usr_meera', account: 'acc_meera_sav', date: d(3), description: 'BigBasket groceries', merchant: 'BigBasket', category: 'groceries', amount: 143_000, channel: 'upi' });

    for (const a of accounts) {
      db.run(`INSERT INTO accounts (id, user_id, type, nickname, account_number, ifsc, branch, opening_balance_paise, balance_paise, status, is_primary, interest_rate_bps, opened_on, maturity_date)
              VALUES (:id, :user_id, :type, :nickname, :account_number, :ifsc, :branch, :opening, :balance, 'active', :primary, :rate, :opened, :maturity)`,
      { ...a, balance: ledger.get(a.id) });
    }
    for (const t of transactions) {
      db.run(`INSERT INTO transactions (id, user_id, account_id, date, posted_at, description, merchant, category_id, direction, amount_paise, status, channel, reference, failure_reason, created_at)
              VALUES (:id, :user_id, :account_id, :date, :posted_at, :description, :merchant, :category_id, :direction, :amount_paise, :status, :channel, :reference, :failure_reason, :created_at)`, t);
    }

    const beneficiaries = [
      ['ben_rahul_s', 'usr_tejas', 'Rahul Sharma', null, 'HDFC Bank', '50100234814821', 'HDFC0001234', 'rahul.sharma@okhdfcbank'],
      ['ben_rahul_v', 'usr_tejas', 'Rahul Verma', null, 'ICICI Bank', '001601547310', 'ICIC0000016', null],
      ['ben_priya', 'usr_tejas', 'Priya Nair', null, 'State Bank of India', '32145569274', 'SBIN0004567', 'priya.nair@oksbi'],
      ['ben_mom', 'usr_tejas', 'Sunita Devi', 'Mom', 'State Bank of India', '20334563345', 'SBIN0001021', 'sunita.devi@oksbi'],
      ['ben_landlord', 'usr_tejas', 'Anil Kapoor', 'Landlord', 'Axis Bank', '917010041188', 'UTIB0000420', null],
      ['ben_aisha_rahul', 'usr_aisha', 'Rahul Mehta', null, 'Kotak Mahindra Bank', '4512889903', 'KKBK0000671', 'rahul.mehta@okkotak']
    ];
    for (const [id, user_id, name, nickname, bank_name, account_number, ifsc, vpa] of beneficiaries) {
      db.run(`INSERT INTO beneficiaries (id, user_id, name, nickname, bank_name, account_number, ifsc, vpa, created_at)
              VALUES (:id, :user_id, :name, :nickname, :bank_name, :account_number, :ifsc, :vpa, :created)`,
      { id, user_id, name, nickname, bank_name, account_number, ifsc, vpa, created: `${addMonths(anchor, -8)}T10:00:00.000Z` });
    }

    const cards = [
      ['crd_tejas_debit', 'usr_tejas', 'acc_tejas_sav', 'visa', 'Visa Signature Debit', '7812', '08/29', 'active', 10_000_000, 1, 0],
      ['crd_tejas_family', 'usr_tejas', 'acc_tejas_fam', 'rupay', 'RuPay Platinum Debit', '3391', '03/28', 'active', 5_000_000, 0, 0],
      ['crd_aisha_debit', 'usr_aisha', 'acc_aisha_sav', 'mastercard', 'Mastercard World Debit', '5520', '11/27', 'active', 10_000_000, 1, 1]
    ];
    for (const [id, user_id, account_id, network, variant, last4, expiry, status, limit, online, intl] of cards) {
      db.run(`INSERT INTO cards (id, user_id, account_id, network, variant, last4, expiry, status, daily_limit_paise, online_enabled, international_enabled, updated_at)
              VALUES (:id, :user_id, :account_id, :network, :variant, :last4, :expiry, :status, :limit, :online, :intl, :created)`,
      { id, user_id, account_id, network, variant, last4, expiry, status, limit, online, intl, created });
    }

    db.run(`INSERT INTO billers (id, user_id, name, category_id, consumer_number) VALUES
      ('blr_tpcodl', 'usr_tejas', 'TPCODL Electricity', 'bills', '10552190447'),
      ('blr_jio', 'usr_tejas', 'Jio Postpaid', 'bills', '9876501234'),
      ('blr_airtel', 'usr_tejas', 'Airtel Xstream Fiber', 'bills', '1402398877')`);
    const period = anchor.slice(0, 7);
    db.run(`INSERT INTO bills (id, user_id, biller_id, period_label, amount_paise, due_date, status) VALUES
      ('bil_tpcodl_cur', 'usr_tejas', 'blr_tpcodl', :period, 138400, :due1, 'due'),
      ('bil_jio_cur', 'usr_tejas', 'blr_jio', :period, 59900, :due2, 'due')`, { period, due1: addDays(anchor, 6), due2: addDays(anchor, 9) });

    const nextOn = (day) => {
      const thisMonth = dayIn(currentMonth, day);
      return thisMonth > anchor ? thisMonth : dayIn(addMonths(currentMonth, 1), day);
    };
    const recurring = [
      ['rec_rent', 'acc_tejas_sav', 'House rent', 'Anil Kapoor', 'rent', 2_200_000, 'standing_instruction', 3],
      ['rec_airtel', 'acc_tejas_sav', 'Airtel Xstream Fiber', 'Airtel', 'bills', 79_900, 'autopay_bill', 2],
      ['rec_sip', 'acc_tejas_sav', 'Axis Bluechip Fund SIP', 'Axis Mutual Fund', 'investments', 500_000, 'sip', 5],
      ['rec_family', 'acc_tejas_sav', 'Family Savings top-up', 'Family Savings', 'transfers', 1_000_000, 'standing_instruction', 6],
      ['rec_cult', 'acc_tejas_sav', 'Cult.fit membership', 'Cult.fit', 'subscriptions', 150_000, 'subscription', 7],
      ['rec_netflix', 'acc_tejas_sav', 'Netflix', 'Netflix', 'subscriptions', 64_900, 'subscription', 12],
      ['rec_spotify', 'acc_tejas_sav', 'Spotify Premium', 'Spotify', 'subscriptions', 11_900, 'subscription', 18],
      ['rec_hotstar', 'acc_tejas_sav', 'Disney+ Hotstar', 'Disney+ Hotstar', 'subscriptions', 29_900, 'subscription', Number(d(5).slice(8, 10))]
    ];
    for (const [id, account_id, name, merchant, category_id, amount, kind, day] of recurring) {
      db.run(`INSERT INTO recurring_payments (id, user_id, account_id, name, merchant, category_id, amount_paise, frequency, kind, next_due_date, status)
              VALUES (:id, 'usr_tejas', :account_id, :name, :merchant, :category_id, :amount, 'monthly', :kind, :next, 'active')`,
      { id, account_id, name, merchant, category_id, amount, kind, next: nextOn(day) });
    }

    const budgets = [['food', 800_000], ['groceries', 700_000], ['shopping', 600_000], ['transport', 500_000], ['entertainment', 200_000]];
    for (const [category, limit] of budgets) {
      db.run(`INSERT INTO budgets (id, user_id, category_id, monthly_limit_paise, updated_at) VALUES (:id, 'usr_tejas', :category, :limit, :created)`,
        { id: `bud_${category}`, category, limit, created });
    }

    const complaintCreated = `${addDays(anchor, -6)}T12:30:00.000Z`;
    db.run(`INSERT INTO complaints (id, user_id, reference, category, transaction_id, description, status, priority, sla_due_date, created_at, updated_at)
            VALUES ('cmp_seed_1', 'usr_tejas', 'CMP-104233', 'refund', :txn, 'Returned a Flipkart order but the refund has not been credited.', 'in_progress', 'normal', :sla, :created, :created)`,
    { txn: flipkartReturn.id, sla: addDays(anchor, 1), created: complaintCreated });
    db.run(`INSERT INTO complaint_events (complaint_id, status, note, created_at) VALUES
      ('cmp_seed_1', 'open', 'Complaint registered via app.', :c1),
      ('cmp_seed_1', 'in_progress', 'Refund request forwarded to the merchant''s acquiring bank.', :c2)`,
    { c1: complaintCreated, c2: `${addDays(anchor, -4)}T09:00:00.000Z` });
  });
}
