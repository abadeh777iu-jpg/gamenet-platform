'use strict';
/**
 * Secure Tool Layer for AI.
 * - Tools receive ONLY a scoped context { userId, roles, gamenetId? }
 * - Every tool re-checks tenant isolation internally.
 * - AI never gets raw SQL / fs / arbitrary code.
 */
const { db } = require('../../db');
const { activeSub, } = require('../subscription');
const { checkLicense } = require('../license');
const { getUsage } = require('../storage');
const { createTicket, getTicket, listTickets, addMessage, escalateToHuman } = require('../ticket');

function assertTenant(ctx, gamenetId){
  if(gamenetId == null) return null;
  if(ctx.roles.some(r => r === 'super_admin' || r === 'admin')) return gamenetId;
  const m = db.prepare(`SELECT 1 FROM gamenet_members WHERE gamenet_id=? AND user_id=?`).get(gamenetId, ctx.userId);
  if(!m){ const e = new Error('TENANT_DENIED'); e.status = 403; throw e; }
  return gamenetId;
}

const tools = {
  get_subscription_status: {
    description: 'وضعیت اشتراک گیم‌نت جاری',
    run(ctx){
      if(!ctx.gamenetId) return { error: 'no_tenant' };
      assertTenant(ctx, ctx.gamenetId);
      const sub = activeSub(ctx.gamenetId);
      if(!sub) return { active:false, message:'اشتراک فعالی وجود ندارد' };
      return { active:true, plan: sub.plan_name, ends_at: sub.ends_at, status: sub.status };
    }
  },
  get_license_status: {
    description: 'وضعیت License گیم‌نت',
    run(ctx){
      if(!ctx.gamenetId) return { error: 'no_tenant' };
      assertTenant(ctx, ctx.gamenetId);
      const lic = db.prepare(`SELECT * FROM licenses WHERE gamenet_id=? AND status='active' ORDER BY id DESC LIMIT 1`).get(ctx.gamenetId);
      if(!lic) return { valid:false, message:'لایسنس فعال نیست' };
      const check = checkLicense(lic.key);
      return { valid: check.valid, reason: check.reason, expires_at: lic.expires_at, key_tail: lic.key.slice(-4) };
    }
  },
  get_storage_status: {
    description: 'مصرف فضای ذخیره‌سازی',
    run(ctx){
      if(!ctx.gamenetId) return { error: 'no_tenant' };
      assertTenant(ctx, ctx.gamenetId);
      return getUsage(ctx.gamenetId);
    }
  },
  list_my_tickets: {
    description: 'لیست تیکت‌های کاربر',
    run(ctx){
      return listTickets({ userId: ctx.userId, gamenetId: ctx.gamenetId || null, limit: 10 }).map(t => ({
        id: t.id, subject: t.subject, status: t.status, priority: t.priority
      }));
    }
  },
  create_ticket: {
    description: 'ایجاد تیکت پشتیبانی',
    run(ctx, args){
      const subject = String(args?.subject || 'درخواست پشتیبانی').slice(0, 200);
      const t = createTicket({ userId: ctx.userId, gamenetId: ctx.gamenetId || null, subject, priority: args?.priority || 'normal' });
      return { id: t.id, public_id: t.public_id, status: t.status };
    }
  },
  escalate_to_human: {
    description: 'انتقال مکالمه به پشتیبان انسانی',
    run(ctx, args){
      const ticketId = Number(args?.ticket_id);
      const t = getTicket(ticketId, ctx.userId) || (ctx.roles.some(r=>r==='super_admin'||r==='admin'||r==='support') ? getTicket(ticketId, null, { forStaff:true }) : null);
      if(!t) return { error: 'ticket_not_found' };
      // ensure tenant scope
      if(t.gamenet_id && ctx.gamenetId && t.gamenet_id !== ctx.gamenetId && !ctx.roles.some(r=>r==='super_admin'||r==='admin')){
        return { error: 'tenant_mismatch' };
      }
      escalateToHuman({ ticketId: t.id, actorUserId: ctx.userId });
      addMessage({ ticketId: t.id, role:'system', content:'مکالمه به پشتیبان انسانی منتقل شد.' });
      return { ok:true, status:'waiting_human' };
    }
  },
  answer_howto: {
    description: 'راهنمای استفاده از بخش‌های سیستم',
    run(ctx, args){
      const q = String(args?.topic || '').toLowerCase();
      const guide = {
        subscription: 'خرید اشتراک: از صفحه «خرید اشتراک» پلن را انتخاب و پرداخت کنید. بعد از پرداخت، اشتراک و لایسنس خودکار فعال می‌شود.',
        license: 'لایسنس در داشبورد گیم‌نت بخش «وضعیت اشتراک» نمایش داده می‌شود. وضعیت را می‌توانید با ابزار وضعیت لایسنس بررسی کنید.',
        storage: 'فضای ذخیره‌سازی در داشبورد قابل مشاهده است. نزدیک ۸۰٪ هشدار دریافت می‌کنید.',
        ticket: 'برای تماس با انسان: تیکت بسازید یا بگویید «به انسان وصل کن» تا منتقل شوید.',
        billing: 'فاکتورها پس از هر پرداخت در بخش صورتحساب ظاهر می‌شوند.',
        ai: 'این دستیار هوش مصنوعی فقط به داده‌های همین گیم‌نت و همین کاربر دسترسی دارد.',
      };
      for(const k of Object.keys(guide)){
        if(q.includes(k)) return { answer: guide[k] };
      }
      return { answer: 'می‌توانم درباره اشتراک، لایسنس، فضا، تیکت و صورتحساب کمک کنم. سؤالت را دقیق‌تر بپرس یا بگو «تیکت بساز».' };
    }
  },
};

function listToolDefs(){
  return Object.entries(tools).map(([name,t]) => ({ name, description: t.description }));
}
function runTool(name, ctx, args){
  const t = tools[name];
  if(!t) return { error: 'unknown_tool' };
  try{
    return t.run(ctx, args || {});
  }catch(e){
    return { error: e.message, status: e.status || 500 };
  }
}
module.exports = { listToolDefs, runTool, tools };
