document.getElementById('t').textContent='تأیید ایمیل';
(async()=>{
  const token=qs('token');
  try{
    await API.post('/api/auth/verify-email',{token});
    document.getElementById('alert').innerHTML='<div class="alert alert-success">ایمیل تأیید شد ✓</div>';
    document.getElementById('form').innerHTML='<a class="btn btn-primary" href="/login">ورود</a>';
  }catch(e){
    document.getElementById('alert').innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`;
  }
})();
