document.getElementById('t').textContent='فراموشی رمز';
document.getElementById('form').innerHTML=`
<label>ایمیل</label><input id="email" type="email">
<button class="btn btn-primary" style="width:100%;margin-top:16px" id="b">ارسال لینک بازنشانی</button>`;
document.getElementById('b').onclick=async()=>{
  try{
    await API.post('/api/auth/forgot',{email:document.getElementById('email').value.trim()});
    document.getElementById('alert').innerHTML='<div class="alert alert-success">در صورت وجود حساب، لینک ارسال شد</div>';
  }catch(e){ document.getElementById('alert').innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
};
