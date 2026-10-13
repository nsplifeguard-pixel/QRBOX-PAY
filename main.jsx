import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import QRCode from 'qrcode';
import './style.css';

const DB_NAME = 'qr-box-pay-local';
const DB_VERSION = 1;
const STORE_NAMES = ['recipients', 'savedQrs', 'settings'];
const banks = ['ธนาคารกรุงเทพ', 'ธนาคารกสิกรไทย', 'ธนาคารกรุงไทย', 'ธนาคารไทยพาณิชย์', 'ธนาคารกรุงศรีอยุธยา', 'ธนาคารทหารไทยธนชาต', 'ธนาคารออมสิน', 'ธนาคารเพื่อการเกษตรและสหกรณ์การเกษตร', 'ธนาคารอื่น'];
const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const stamp = () => new Date().toISOString();

function openDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('เบราว์เซอร์นี้ไม่รองรับ IndexedDB'));
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of STORE_NAMES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('เปิดฐานข้อมูลในอุปกรณ์ไม่สำเร็จ'));
  });
}
async function dbAll(store) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly'); const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []); req.onerror = () => reject(req.error); tx.oncomplete = () => db.close();
  });
}
async function dbPut(store, item) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(item);
    tx.oncomplete = () => { db.close(); resolve(item); };
    tx.onerror = () => { const err = tx.error || new Error('บันทึกข้อมูลไม่สำเร็จ'); db.close(); reject(err); };
    tx.onabort = () => { const err = tx.error || new Error('การบันทึกถูกยกเลิก'); db.close(); reject(err); };
  });
}
async function dbDelete(store, id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).delete(id);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { const err = tx.error || new Error('ลบข้อมูลไม่สำเร็จ'); db.close(); reject(err); };
  });
}
function tlv(id, value) { const v = String(value); if (v.length > 99) throw new Error(`ข้อมูลช่อง ${id} ยาวเกินมาตรฐาน QR`); return id + String(v.length).padStart(2, '0') + v; }
function crc16(text) {
  let crc = 0xffff;
  for (let i = 0; i < text.length; i++) {
    crc ^= text.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
    crc &= 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
function promptPayPayload(identifier, amount) {
  const raw = identifier.replace(/[\s-]/g, '');
  let proxyType, proxyValue;
  if (/^0\d{9}$/.test(raw)) { proxyType = '01'; proxyValue = '0066' + raw.slice(1); }
  else if (/^\d{13}$/.test(raw)) { proxyType = '02'; proxyValue = raw; }
  else throw new Error('กรุณากรอกเบอร์ PromptPay 10 หลัก หรือเลขประจำตัวประชาชน/ผู้เสียภาษี 13 หลัก');
  const merchant = tlv('00', 'A000000677010111') + tlv(proxyType, proxyValue);
  let payload = tlv('00', '01') + tlv('01', amount ? '12' : '11') + tlv('29', merchant) + tlv('53', '764') + tlv('58', 'TH');
  if (amount) {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0 || Math.round(n * 100) !== n * 100) throw new Error('จำนวนเงินต้องมากกว่า 0 และไม่เกิน 2 ตำแหน่งทศนิยม');
    payload += tlv('54', n.toFixed(2));
  }
  payload += '6304';
  return payload + crc16(payload);
}
function money(v) { return new Intl.NumberFormat('th-TH', { style: 'currency', currency: 'THB' }).format(Number(v || 0)); }
function dateText(v) { try { return new Date(v).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }); } catch { return ''; } }

function App() {
  const [page, setPage] = useState('home');
  const [recipients, setRecipients] = useState([]);
  const [savedQrs, setSavedQrs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);
  const [selectedRecipient, setSelectedRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [qrName, setQrName] = useState('');
  const [qrNote, setQrNote] = useState('');
  const [generated, setGenerated] = useState(null);
  const [search, setSearch] = useState('');
  const [settings, setSettings] = useState({ displayName: 'QR BOX PAY' });
  const [form, setForm] = useState(emptyForm());

  function emptyForm() { return { label: '', type: 'promptpay', provider: 'PromptPay', owner: '', identifier: '', accountNumber: '', note: '', isDefault: false }; }
  const notify = (kind, message) => { setNotice({ kind, message }); window.setTimeout(() => setNotice(null), 4200); };

  async function refresh() {
    setLoading(true);
    try {
      const [r, q, s] = await Promise.all([dbAll('recipients'), dbAll('savedQrs'), dbAll('settings')]);
      setRecipients(r.sort((a,b) => Number(b.isDefault) - Number(a.isDefault) || b.updatedAt.localeCompare(a.updatedAt)));
      setSavedQrs(q.sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)));
      if (s[0]?.value) setSettings(s[0].value);
    } catch (e) { notify('error', `${e.message} — ข้อมูลยังไม่ถูกบันทึก`); }
    finally { setLoading(false); }
  }
  useEffect(() => { refresh(); }, []);

  const selected = recipients.find(r => r.id === selectedRecipient);
  const filteredQrs = useMemo(() => savedQrs.filter(q => `${q.name} ${q.recipientLabel}`.toLowerCase().includes(search.toLowerCase())), [savedQrs, search]);

  async function saveRecipient(e) {
    e.preventDefault();
    if (!form.label.trim()) return notify('error', 'กรุณากรอกชื่อเรียกบัญชี');
    if (!form.owner.trim()) return notify('error', 'กรุณากรอกชื่อเจ้าของบัญชี');
    if (form.type === 'promptpay') {
      const id = form.identifier.replace(/[\s-]/g, '');
      if (!/^0\d{9}$/.test(id) && !/^\d{13}$/.test(id)) return notify('error', 'PromptPay ต้องเป็นเบอร์โทร 10 หลักหรือเลขประจำตัว 13 หลัก');
    }
    if (form.type === 'bank' && (!form.provider || !form.accountNumber.trim())) return notify('error', 'กรุณาเลือกธนาคารและกรอกเลขบัญชี');
    if (form.type === 'wallet' && (!form.provider || !form.identifier.trim())) return notify('error', 'กรุณาเลือกผู้ให้บริการและกรอกหมายเลขกระเป๋าเงิน');
    setBusy(true);
    try {
      const now = stamp(); const item = { ...form, id: editing?.id || uid(), createdAt: editing?.createdAt || now, updatedAt: now, label: form.label.trim(), owner: form.owner.trim(), note: form.note.trim() };
      if (item.isDefault) {
        for (const old of recipients.filter(r => r.isDefault && r.id !== item.id)) await dbPut('recipients', { ...old, isDefault: false, updatedAt: now });
      }
      await dbPut('recipients', item); await refresh(); setEditing(null); setForm(emptyForm()); setPage('recipients'); notify('success', 'บันทึกข้อมูลผู้รับเงินลงในอุปกรณ์แล้ว');
    } catch (err) { notify('error', `บันทึกไม่สำเร็จ: ${err.message}`); }
    finally { setBusy(false); }
  }
  function startEdit(item) { setEditing(item); setForm({ ...emptyForm(), ...item }); setPage('recipient-form'); }
  async function deleteRecipient(item) {
    if (!window.confirm(`ยืนยันลบบัญชี “${item.label}” หรือไม่? รายการ QR ที่บันทึกไว้จะไม่ถูกลบ`)) return;
    try { await dbDelete('recipients', item.id); await refresh(); if (selectedRecipient === item.id) setSelectedRecipient(''); notify('success', 'ลบบัญชีรับเงินแล้ว'); }
    catch (e) { notify('error', `ลบไม่สำเร็จ: ${e.message}`); }
  }
  async function createQr(e) {
    e.preventDefault();
    if (!selected) return notify('error', 'กรุณาเลือกบัญชีรับเงิน');
    if (selected.type !== 'promptpay') return notify('error', 'บัญชีนี้ยังสร้าง QR รับเงินจริงจากข้อมูลที่มีไม่ได้ ต้องเชื่อมต่อมาตรฐาน/API ที่ได้รับอนุญาตจากผู้ให้บริการก่อน');
    setBusy(true); setGenerated(null);
    try {
      const payload = promptPayPayload(selected.identifier, amount.trim());
      const dataUrl = await QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 2, width: 420, color: { dark: '#080b10', light: '#ffffff' } });
      const svg = await QRCode.toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 420, color: { dark: '#080b10', light: '#ffffff' } });
      setGenerated({ payload, dataUrl, svg, recipientId: selected.id, recipientLabel: selected.label, owner: selected.owner, amount: amount ? Number(amount).toFixed(2) : '', name: qrName.trim() || `QR ${selected.label}`, note: qrNote.trim(), createdAt: stamp() });
      notify('success', 'สร้าง PromptPay QR สำเร็จ — ตรวจสอบข้อมูลก่อนนำไปใช้งาน');
    } catch (err) { notify('error', `สร้าง QR ไม่สำเร็จ: ${err.message}`); }
    finally { setBusy(false); }
  }
  async function saveQr() {
    if (!generated) return;
    setBusy(true);
    try { const now = stamp(); const item = { ...generated, id: uid(), createdAt: now, updatedAt: now }; await dbPut('savedQrs', item); await refresh(); notify('success', 'บันทึก QR ลงในอุปกรณ์แล้ว'); }
    catch (e) { notify('error', `บันทึก QR ไม่สำเร็จ: ${e.message}`); }
    finally { setBusy(false); }
  }
  async function deleteQr(item) {
    if (!window.confirm(`ยืนยันลบรายการ “${item.name}” หรือไม่?`)) return;
    try { await dbDelete('savedQrs', item.id); await refresh(); notify('success', 'ลบรายการ QR แล้ว'); }
    catch (e) { notify('error', `ลบไม่สำเร็จ: ${e.message}`); }
  }
  async function openSaved(item) {
    try { const dataUrl = await QRCode.toDataURL(item.payload, { errorCorrectionLevel: 'M', margin: 2, width: 420 }); const svg = await QRCode.toString(item.payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 420 }); setGenerated({ ...item, dataUrl, svg }); setPage('create'); }
    catch (e) { notify('error', `เปิด QR ไม่สำเร็จ: ${e.message}`); }
  }
  function downloadPng() {
    if (!generated?.dataUrl) return;
    const a = document.createElement('a'); a.href = generated.dataUrl; a.download = `${safeFile(generated.name)}.png`; a.click();
  }
  function downloadSvg() {
    if (!generated?.svg) return;
    const blob = new Blob([generated.svg], { type: 'image/svg+xml;charset=utf-8' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `${safeFile(generated.name)}.svg`; a.click(); URL.revokeObjectURL(url);
  }
  function safeFile(s) { return String(s || 'qr-box-pay').replace(/[^a-z0-9ก-๙_-]+/gi, '-').slice(0, 60) || 'qr-box-pay'; }
  async function shareSite() {
    const url = window.location.origin + window.location.pathname;
    try { if (navigator.share) await navigator.share({ title: 'QR BOX PAY', url }); else if (navigator.clipboard) { await navigator.clipboard.writeText(url); notify('success', 'คัดลอกลิงก์เว็บไซต์แล้ว'); } else notify('error', `คัดลอกลิงก์นี้: ${url}`); }
    catch (e) { if (e.name !== 'AbortError') notify('error', 'แชร์ลิงก์ไม่สำเร็จ'); }
  }
  async function saveSettings(e) {
    e.preventDefault();
    try { await dbPut('settings', { id: 'main', value: settings, updatedAt: stamp() }); notify('success', 'บันทึกการตั้งค่าแล้ว'); }
    catch (e) { notify('error', `บันทึกการตั้งค่าไม่สำเร็จ: ${e.message}`); }
  }

  const nav = [{ id: 'home', icon: '⌂', label: 'หน้าหลัก' }, { id: 'create', icon: '▦', label: 'สร้าง QR' }, { id: 'recipients', icon: '▣', label: 'บัญชีรับเงิน' }, { id: 'saved', icon: '◷', label: 'QR ที่บันทึก' }, { id: 'settings', icon: '⚙', label: 'ตั้งค่า' }];
  return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand" onClick={() => setPage('home')} aria-label="QR BOX PAY หน้าหลัก"><img src="/logo.jpeg" alt="QR BOX PAY logo"/><span>QR BOX <b>PAY</b><small>PAYMENT TOOLKIT</small></span></button>
      <nav>{nav.map(n => <button key={n.id} className={page === n.id || (page === 'recipient-form' && n.id === 'recipients') ? 'nav-item active' : 'nav-item'} onClick={() => { setPage(n.id); if (n.id === 'recipient-form') { setEditing(null); setForm(emptyForm()); } }}><span className="nav-icon">{n.icon}</span>{n.label}</button>)}</nav>
      <div className="sidebar-bottom"><div className="storage-dot"/><div><b>Local storage</b><small>จัดเก็บในอุปกรณ์นี้</small></div></div>
    </aside>
    <main className="main-content">
      <header className="topbar"><div className="mobile-brand"><img src="/logo.jpeg" alt=""/><b>QR BOX PAY</b></div><div className="top-spacer"/><span className="secure-label"><span/> บันทึกข้อมูลในอุปกรณ์</span><button className="share-btn" onClick={shareSite}>↗ <span>แชร์เว็บไซต์</span></button></header>
      {notice && <div className={`toast ${notice.kind}`} role="status">{notice.kind === 'success' ? '✓' : '!' } {notice.message}<button onClick={() => setNotice(null)} aria-label="ปิด">×</button></div>}
      {loading ? <section className="loading-panel"><div className="spinner"/>กำลังอ่านข้อมูลที่บันทึกไว้…</section> : <>
      {page === 'home' && <>
        <section className="hero"><div className="hero-copy"><div className="eyebrow"><span/> PAYMENT WORKSPACE</div><h1>รับเงินง่ายขึ้น<br/><em>ในแบบของคุณ</em></h1><p>จัดการผู้รับเงิน สร้าง PromptPay QR และกลับมาเปิดรายการที่บันทึกไว้ได้จากอุปกรณ์นี้</p><div className="hero-actions"><button className="primary-btn" onClick={() => { setGenerated(null); setPage('create'); }}>＋ สร้าง QR รับเงิน</button><button className="secondary-btn" onClick={() => { setEditing(null); setForm(emptyForm()); setPage('recipient-form'); }}>เพิ่มบัญชีรับเงิน</button></div></div><div className="hero-art"><div className="glow"/><img src="/logo.jpeg" alt="QR BOX PAY"/><div className="art-tag">SCAN · PAY · DONE</div></div></section>
        <section className="stats-grid"><Stat icon="▣" label="บัญชีรับเงิน" value={recipients.length} hint="รายการที่บันทึกไว้"/><Stat icon="▦" label="QR ที่บันทึก" value={savedQrs.length} hint="เปิดดูซ้ำได้"/><Stat icon="◉" label="ช่องทาง QR" value="PromptPay" hint="สร้างตามรูปแบบ EMVCo"/></section>
        <section className="section-block"><div className="section-heading"><div><div className="eyebrow">QUICK ACCESS</div><h2>เริ่มต้นใช้งาน</h2></div></div><div className="quick-grid"><QuickCard icon="▦" title="สร้าง QR รับเงิน" desc="สร้าง PromptPay แบบกำหนดหรือไม่กำหนดจำนวนเงิน" onClick={() => setPage('create')}/><QuickCard icon="▣" title="จัดการบัญชี" desc="เพิ่ม แก้ไข และเลือกบัญชีรับเงินหลัก" onClick={() => setPage('recipients')}/><QuickCard icon="◷" title="รายการที่บันทึก" desc="เรียกดูและดาวน์โหลด QR เดิม" onClick={() => setPage('saved')}/></div></section>
        <div className="notice-panel"><span>i</span><p><b>ข้อมูลของคุณอยู่ในอุปกรณ์นี้</b><br/>รายการจะอยู่หลังรีเฟรชและเปิดเว็บใหม่บนเบราว์เซอร์เดิม แต่ยังไม่ซิงก์ข้ามอุปกรณ์หรือเบราว์เซอร์ หากล้างข้อมูลเว็บไซต์ ข้อมูลอาจสูญหาย</p></div>
      </>}
      {page === 'create' && <><PageTitle eyebrow="QR GENERATOR" title="สร้าง QR รับเงิน" subtitle="เลือกผู้รับเงิน ตรวจสอบรายละเอียด แล้วดาวน์โหลดหรือบันทึก QR"/><div className="two-col"><form className="panel form-panel" onSubmit={createQr}><h3>รายละเอียด QR</h3><Field label="บัญชีรับเงิน" required><select value={selectedRecipient} onChange={e => setSelectedRecipient(e.target.value)} required><option value="">เลือกบัญชีรับเงิน</option>{recipients.map(r => <option key={r.id} value={r.id}>{r.label} · {r.type === 'promptpay' ? 'PromptPay' : r.provider}</option>)}</select></Field>{selected && <div className="selected-summary"><b>{selected.owner}</b><span>{selected.type === 'promptpay' ? maskId(selected.identifier) : selected.type === 'bank' ? `${selected.provider} · ${maskId(selected.accountNumber)}` : `${selected.provider} · ${maskId(selected.identifier)}`}</span></div>}<Field label="จำนวนเงิน (บาท)" hint="เว้นว่างเพื่อสร้าง QR แบบไม่ระบุจำนวนเงิน"><input inputMode="decimal" type="number" min="0.01" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} placeholder="เช่น 250.00"/></Field><Field label="ชื่อรายการ QR"><input value={qrName} onChange={e => setQrName(e.target.value)} placeholder="เช่น รับชำระค่าบริการ" maxLength={80}/></Field><Field label="หมายเหตุ (สำหรับบันทึกในแอป)"><textarea value={qrNote} onChange={e => setQrNote(e.target.value)} placeholder="หมายเหตุส่วนตัว ไม่ได้ฝังใน QR" rows="3" maxLength={300}/></Field><div className="inline-warning"><b>ข้อควรรู้</b><span>สร้าง QR ได้เฉพาะบัญชี PromptPay ที่มีข้อมูลถูกต้อง บัญชีธนาคารหรือ Wallet ต้องใช้ QR/API ที่ผู้ให้บริการรับรอง</span></div><button className="primary-btn full" disabled={busy || !selectedRecipient}>{busy ? 'กำลังสร้าง…' : '▦ สร้าง QR Code'}</button></form>
        <section className="panel preview-panel"><h3>ตัวอย่าง QR Code</h3>{generated ? <><div className="qr-paper"><img src={generated.dataUrl} alt="PromptPay QR Code"/><div className="qr-brand">QR BOX PAY</div></div><h4>{generated.name}</h4><div className="preview-meta"><span>ผู้รับเงิน</span><b>{generated.owner || '—'}</b><span>บัญชี</span><b>{generated.recipientLabel}</b><span>จำนวนเงิน</span><b className="amount-text">{generated.amount ? money(generated.amount) : 'ไม่ระบุจำนวนเงิน'}</b></div><div className="download-grid"><button className="secondary-btn" onClick={downloadPng}>↓ ดาวน์โหลด PNG</button><button className="secondary-btn" onClick={downloadSvg}>↓ ดาวน์โหลด SVG</button></div><button className="primary-btn full" onClick={saveQr} disabled={busy}>บันทึก QR ไว้เปิดภายหลัง</button><p className="tiny-note">ตรวจสอบชื่อผู้รับและจำนวนเงินในแอปธนาคารก่อนยืนยันทุกครั้ง</p></> : <div className="empty-preview"><div className="qr-placeholder">▦</div><b>QR ของคุณจะแสดงที่นี่</b><p>เลือกบัญชี PromptPay และกดสร้าง QR Code</p></div>}</section></div></>}
      {page === 'recipients' && <><PageTitle eyebrow="RECIPIENT DIRECTORY" title="บัญชีรับเงิน" subtitle="ข้อมูลผู้รับเงินที่บันทึกอยู่ในอุปกรณ์นี้" action={<button className="primary-btn" onClick={() => { setEditing(null); setForm(emptyForm()); setPage('recipient-form'); }}>＋ เพิ่มบัญชี</button>}/>{recipients.length ? <div className="recipient-list">{recipients.map(r => <article className="panel recipient-card" key={r.id}><div className="recipient-icon">{r.type === 'promptpay' ? '฿' : r.type === 'bank' ? '▤' : '◉'}</div><div className="recipient-info"><div className="recipient-title">{r.label} {r.isDefault && <span className="pill">บัญชีหลัก</span>}</div><div className="muted">{typeLabel(r.type)} · {r.provider}</div><b>{r.owner}</b><span className="muted">{maskId(r.type === 'bank' ? r.accountNumber : r.identifier)}</span><small>แก้ไขล่าสุด {dateText(r.updatedAt)}</small></div><div className="card-actions"><button onClick={() => startEdit(r)}>แก้ไข</button><button className="danger-text" onClick={() => deleteRecipient(r)}>ลบ</button></div></article>)}</div> : <EmptyState title="ยังไม่มีบัญชีรับเงิน" desc="เพิ่มข้อมูลผู้รับเงินเพื่อเริ่มสร้าง QR Code" action="＋ เพิ่มบัญชีรับเงิน" onClick={() => { setEditing(null); setForm(emptyForm()); setPage('recipient-form'); }}/>}</>}
      {page === 'recipient-form' && <><PageTitle eyebrow="RECIPIENT DETAILS" title={editing ? 'แก้ไขบัญชีรับเงิน' : 'เพิ่มบัญชีรับเงิน'} subtitle="กรอกเฉพาะข้อมูลที่เกี่ยวข้องกับช่องทางที่เลือก"/><form className="panel form-panel narrow" onSubmit={saveRecipient}><Field label="ชื่อเรียกบัญชี" required><input value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} placeholder="เช่น บัญชีร้านหลัก" maxLength={80} required/></Field><Field label="ประเภทช่องทาง" required><select value={form.type} onChange={e => { const type = e.target.value; setForm({ ...form, type, provider: type === 'promptpay' ? 'PromptPay' : type === 'bank' ? banks[0] : 'TrueMoney Wallet' }); }}><option value="promptpay">PromptPay</option><option value="bank">บัญชีธนาคาร</option><option value="wallet">e-Wallet</option></select></Field>{form.type === 'bank' && <Field label="ธนาคาร" required><select value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value })}>{banks.map(b => <option key={b}>{b}</option>)}</select></Field>}{form.type === 'wallet' && <Field label="ผู้ให้บริการ Wallet" required><select value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value })}><option>TrueMoney Wallet</option><option>ผู้ให้บริการอื่น</option></select></Field>}<Field label="ชื่อเจ้าของบัญชี / ผู้รับเงิน" required><input value={form.owner} onChange={e => setForm({ ...form, owner: e.target.value })} placeholder="ชื่อเจ้าของบัญชี" maxLength={120} required/></Field>{form.type === 'bank' ? <Field label="เลขบัญชี" required><input value={form.accountNumber} onChange={e => setForm({ ...form, accountNumber: e.target.value })} inputMode="numeric" placeholder="เลขบัญชีธนาคาร" maxLength={30} required/></Field> : <Field label={form.type === 'promptpay' ? 'เบอร์โทร PromptPay หรือเลขประจำตัว 13 หลัก' : 'หมายเลขกระเป๋าเงิน'} required hint={form.type === 'promptpay' ? 'เบอร์โทร 10 หลัก หรือเลขประจำตัว/ผู้เสียภาษี 13 หลัก' : 'บันทึกไว้สำหรับอ้างอิง ยังไม่สามารถสร้าง QR รับเงินจริงจากหมายเลขนี้โดยตรง'}><input value={form.identifier} onChange={e => setForm({ ...form, identifier: e.target.value })} inputMode="numeric" placeholder={form.type === 'promptpay' ? '0812345678' : 'หมายเลข Wallet'} maxLength={30} required/></Field>}<Field label="หมายเหตุ"><textarea value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} rows="3" placeholder="ไม่บังคับ" maxLength={300}/></Field><label className="checkbox-line"><input type="checkbox" checked={form.isDefault} onChange={e => setForm({ ...form, isDefault: e.target.checked })}/> ตั้งเป็นบัญชีหลัก</label>{form.type !== 'promptpay' && <div className="inline-warning"><b>ข้อจำกัดการสร้าง QR</b><span>ข้อมูลบัญชีเพียงอย่างเดียวไม่ใช่ QR รับเงินที่ผ่านมาตรฐาน รายการนี้จะถูกบันทึกไว้ แต่จะไม่แสดงว่าสร้าง QR รับเงินจริงได้จนกว่าจะเชื่อมต่อผู้ให้บริการที่รองรับ</span></div>}<div className="form-actions"><button type="button" className="secondary-btn" onClick={() => setPage('recipients')}>ยกเลิก</button><button className="primary-btn" disabled={busy}>{busy ? 'กำลังบันทึก…' : 'บันทึกบัญชี'}</button></div></form></>}
      {page === 'saved' && <><PageTitle eyebrow="SAVED QR LIBRARY" title="QR ที่บันทึกไว้" subtitle="เปิดดู ดาวน์โหลด หรือสร้างไฟล์ QR จากรายการเดิม"/><div className="search-row"><input value={search} onChange={e => setSearch(e.target.value)} placeholder="ค้นหาชื่อรายการหรือบัญชี…"/><span>{filteredQrs.length} รายการ</span></div>{filteredQrs.length ? <div className="saved-grid">{filteredQrs.map(q => <article className="panel saved-card" key={q.id}><img src={q.dataUrl} alt=""/><div className="saved-details"><b>{q.name}</b><span>{q.recipientLabel}</span><strong>{q.amount ? money(q.amount) : 'ไม่ระบุจำนวนเงิน'}</strong><small>{dateText(q.createdAt)}</small></div><div className="saved-actions"><button className="secondary-btn" onClick={() => openSaved(q)}>เปิด QR</button><button className="danger-text" onClick={() => deleteQr(q)}>ลบ</button></div></article>)}</div> : <EmptyState title={search ? 'ไม่พบรายการที่ค้นหา' : 'ยังไม่มี QR ที่บันทึก'} desc="สร้าง QR แล้วกดบันทึก เพื่อกลับมาเปิดดูในภายหลัง" action="สร้าง QR รับเงิน" onClick={() => setPage('create')}/>}</>}
      {page === 'settings' && <><PageTitle eyebrow="PREFERENCES" title="ตั้งค่า" subtitle="การตั้งค่าทั่วไปสำหรับเว็บไซต์นี้"/><form className="panel form-panel narrow" onSubmit={saveSettings}><Field label="ชื่อแอปที่แสดง"><input value={settings.displayName || ''} onChange={e => setSettings({ ...settings, displayName: e.target.value })} maxLength={80}/></Field><button className="primary-btn">บันทึกการตั้งค่า</button><div className="settings-info"><h4>พื้นที่จัดเก็บข้อมูล</h4><p>IndexedDB ในเบราว์เซอร์เครื่องนี้ · ไม่ต้องใช้บัญชีผู้ใช้ · ไม่ซิงก์ข้ามอุปกรณ์</p><p>การล้างข้อมูลเว็บไซต์หรือถอนการติดตั้ง/รีเซ็ตเบราว์เซอร์อาจทำให้ข้อมูลสูญหาย ควรเก็บสำเนาข้อมูลสำคัญไว้</p><h4>การยืนยันการชำระเงิน</h4><p>แอปนี้สร้าง QR เท่านั้น ยังไม่ได้เชื่อมต่อ API หรือ Webhook จากธนาคารเพื่อยืนยันการชำระเงินจริง</p><h4>ความเป็นส่วนตัว</h4><p>ข้อมูลที่บันทึกในแอปนี้อยู่ในพื้นที่จัดเก็บของเบราว์เซอร์นี้ การแชร์เว็บไซต์จะแชร์เฉพาะ URL ไม่แนบข้อมูลบัญชีหรือ QR</p></div></form></>}
      </>}
      <footer className="footer"><span>QR BOX PAY</span><span>สร้าง QR อย่างระมัดระวัง · ตรวจสอบผู้รับก่อนโอนทุกครั้ง</span></footer>
    </main>
  </div>;
}
function maskId(s='') { const v = String(s); if (v.length <= 4) return v; return `${'•'.repeat(Math.min(8, Math.max(3, v.length - 4)))}${v.slice(-4)}`; }
function typeLabel(t) { return t === 'promptpay' ? 'PromptPay' : t === 'bank' ? 'บัญชีธนาคาร' : 'e-Wallet'; }
function Stat({ icon, label, value, hint }) { return <div className="stat-card"><span className="stat-icon">{icon}</span><div><span>{label}</span><strong>{value}</strong><small>{hint}</small></div></div>; }
function QuickCard({ icon, title, desc, onClick }) { return <button className="quick-card" onClick={onClick}><span className="quick-icon">{icon}</span><b>{title}</b><p>{desc}</p><span className="quick-arrow">↗</span></button>; }
function PageTitle({ eyebrow, title, subtitle, action }) { return <div className="page-title"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{subtitle}</p></div>{action}</div>; }
function Field({ label, required, hint, children }) { return <label className="field"><span>{label}{required && <i> *</i>}</span>{children}{hint && <small>{hint}</small>}</label>; }
function EmptyState({ title, desc, action, onClick }) { return <div className="empty-state"><div className="empty-symbol">▦</div><h3>{title}</h3><p>{desc}</p><button className="primary-btn" onClick={onClick}>{action}</button></div>; }

createRoot(document.getElementById('root')).render(<App />);
