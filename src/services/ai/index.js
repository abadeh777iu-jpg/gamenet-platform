'use strict';
const config = require('../../config');
const { listToolDefs, runTool } = require('./tools');
const { addMessage, getTicket } = require('../ticket');
const { activeSub } = require('../subscription');
const { getUsage } = require('../storage');

/**
 * AI chat: constrained loop.
 * - If AI_API_URL configured → OpenAI-compatible function calling (optional).
 * - Else → built-in deterministic assistant that still uses the SAME tool layer.
 * Context always scoped: { userId, roles, gamenetId }.
 */
async function chat({ userId, roles, gamenetId=null, ticketId, message }){
  const ctx = { userId, roles, gamenetId };
  const clean = String(message||'').slice(0, 4000);
  if(!clean.trim()) return { reply:'پیام خالی است.', tools_used: [] };

  // record user message on ticket (create if needed)
  let tid = ticketId;
  if(tid){
    const t = getTicket(tid, userId, { forStaff: roles.some(r=>['super_admin','admin','support'].includes(r)) });
    if(!t) { return { error:'ticket_not_found' }; }
    if(gamenetId && t.gamenet_id && t.gamenet_id !== gamenetId && !roles.some(r=>['super_admin','admin'].includes(r))){
      return { error:'tenant_forbidden' };
    }
    addMessage({ ticketId: tid, role:'user', content: clean });
  }

  const toolsUsed = [];
  let reply = '';

  if(config.ai.apiUrl && config.ai.apiKey){
    try{
      const r = await fetch(config.ai.apiUrl, {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Authorization': `Bearer ${config.ai.apiKey}` },
        body: JSON.stringify({
          model: config.ai.model || 'gpt-4o-mini',
          messages: [
            { role:'system', content: `You are a support assistant for a GameNet panel. Always use tools for data. Roles: ${roles.join(',')}. Tenant: ${gamenetId||'none'}. Reply in Persian.` },
            { role:'user', content: clean },
          ],
          tools: listToolDefs().map(t => ({ type:'function', function:{ name:t.name, description:t.description, parameters:{ type:'object', properties:{} } } })),
        }),
      });
      if(r.ok){
        const data = await r.json();
        reply = data.choices?.[0]?.message?.content || '';
        // NOTE: tool-call execution for remote LLM is intentionally gated:
        // only allowlisted tools via runTool — never free-form.
      }
    }catch(e){
      console.error('[ai] remote failed, fallback', e.message);
    }
  }

  if(!reply){
    // Deterministic tool-driven assistant (always safe)
    const q = clean.toLowerCase();
    if(/اشتراک|subscription|پلن|plan|انقضا|تمدید/.test(q)){
      const s = runTool('get_subscription_status', ctx);
      toolsUsed.push('get_subscription_status');
      reply = s.active
        ? `اشتراک فعال است — پلن «${s.plan}» تا ${s.ends_at}.`
        : 'اشتراک فعالی ندارم. از صفحه خرید اشتراک می‌توانید پلن بگیرید.';
    } else if(/لایسنس|license|کلید/.test(q)){
      const s = runTool('get_license_status', ctx);
      toolsUsed.push('get_license_status');
      reply = s.valid ? `لایسنس معتبر است (پایان: ${s.expires_at || '—'}).` : `لایسنس فعال نیست (${s.reason}).`;
    } else if(/فضا|ذخیره|storage|پر شدن/.test(q)){
      const s = runTool('get_storage_status', ctx);
      toolsUsed.push('get_storage_status');
      if(s.error) reply = 'فضایی برای نمایش نیست.';
      else {
        const pct = Math.round((s.ratio||0)*100);
        reply = `مصرف فضا: ${pct}% (${s.used_bytes} از ${s.limit_bytes} بایت) — ${s.file_count} فایل.`;
      }
    } else if(/تیکت|ticket|پشتیبانی/.test(q) && /بساز|ایجاد|create/.test(q)){
      const s = runTool('create_ticket', ctx, { subject: clean.slice(0,120) });
      toolsUsed.push('create_ticket');
      reply = `تیکت #${s.public_id || s.id} ساخته شد.`;
      tid = s.id;
    } else if(/انسان|اپراتور|human|escalate|وصل/.test(q)){
      if(tid){
        const s = runTool('escalate_to_human', ctx, { ticket_id: tid });
        toolsUsed.push('escalate_to_human');
        reply = s.ok ? 'به پشتیبان انسانی منتقل شد. به‌زودی پاسخ می‌دهند.' : 'انتقال ممکن نشد.';
      } else {
        const s = runTool('create_ticket', ctx, { subject:'درخواست اتصال به پشتیبان انسانی', priority:'high' });
        toolsUsed.push('create_ticket','escalate_to_human');
        const esc = runTool('escalate_to_human', ctx, { ticket_id: s.id });
        tid = s.id;
        reply = esc.ok ? 'تیکت ساخته و به پشتیبان انسانی منتقل شد.' : 'تیکت ساخته شد.';
      }
    } else if(/چطور|كيف|how|راهنما|استفاده/.test(q)){
      const s = runTool('answer_howto', ctx, { topic: clean });
      toolsUsed.push('answer_howto');
      reply = s.answer;
    } else if(/وضعیت|status|کلی/.test(q)){
      const sub = runTool('get_subscription_status', ctx);
      const st = runTool('get_storage_status', ctx);
      toolsUsed.push('get_subscription_status','get_storage_status');
      reply = `اشتراک: ${sub.active ? sub.plan+' تا '+sub.ends_at : 'غیرفعال'} | فضا: ${st.ratio!=null? Math.round(st.ratio*100)+'%':'—'}`;
    } else {
      const s = runTool('answer_howto', ctx, { topic: clean });
      toolsUsed.push('answer_howto');
      reply = s.answer;
    }
  }

  if(tid) addMessage({ ticketId: tid, role:'assistant', content: reply, meta:{ tools: toolsUsed } });
  return { reply, tools_used: toolsUsed, ticket_id: tid };
}
module.exports = { chat };
