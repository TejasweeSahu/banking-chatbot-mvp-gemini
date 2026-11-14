/**
 * Add-beneficiary form. Details go straight to the bank API (never to the
 * assistant/LLM), then come back as a confirmation preview.
 */

import { useState } from 'react';
import { api } from '../api.js';
import { ConfirmationCard } from './ConfirmationCard.jsx';

export function AddBeneficiaryForm({ prefillName = '', onDone }) {
  const [form, setForm] = useState({ name: prefillName, nickname: '', accountNumber: '', confirmAccountNumber: '', ifsc: '', vpa: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const params = Object.fromEntries(Object.entries(form).filter(([k, v]) => v.trim() || ['name', 'accountNumber', 'confirmAccountNumber', 'ifsc'].includes(k)));
      const res = await api('/actions', { method: 'POST', body: { type: 'add_beneficiary', params } });
      setAction(res.action);
    } catch (err) {
      const first = Array.isArray(err.details) ? err.details[0] : null;
      setError(first?.problem ? `${first.field}: ${first.problem}` : err.message);
    } finally {
      setBusy(false);
    }
  }

  if (action) return <ConfirmationCard action={action} onResolved={onDone} />;

  return (
    <form className="form" onSubmit={submit} autoComplete="off">
      <p className="form-intro">These details are sent directly to Northstar, not to the assistant.</p>
      <label>Full name<input required maxLength={60} value={form.name} onChange={set('name')} /></label>
      <label>Nickname <span className="optional">optional</span><input maxLength={30} value={form.nickname} onChange={set('nickname')} /></label>
      <label>Account number<input required inputMode="numeric" pattern="\d{9,18}" title="9 to 18 digits" maxLength={18} value={form.accountNumber} onChange={set('accountNumber')} /></label>
      <label>Re-enter account number<input required inputMode="numeric" pattern="\d{9,18}" maxLength={18} value={form.confirmAccountNumber} onChange={set('confirmAccountNumber')} onPaste={(e) => e.preventDefault()} /></label>
      <label>IFSC<input required pattern="[A-Za-z]{4}0[A-Za-z0-9]{6}" title="For example HDFC0001234" maxLength={11} value={form.ifsc} onChange={set('ifsc')} style={{ textTransform: 'uppercase' }} /></label>
      <label>UPI ID <span className="optional">optional</span><input maxLength={100} value={form.vpa} onChange={set('vpa')} placeholder="name@bank" /></label>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <button className="btn btn-primary" disabled={busy}>{busy ? 'Checking…' : 'Review beneficiary'}</button>
    </form>
  );
}
