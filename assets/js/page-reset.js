document.getElementById('t').textContent='بازنشانی رمز';
document.getElementById('form').innerHTML=`
<label>رمز جدید</label><input id="p1" type="password" minlength="8">
<label>تکرار رمز</label><input id="p2" type="password" minlength="8">
<button class="btn btn-primary" style="width:100%;margin-top:16px" id="b">ثبت رمز جدید</button>`;
document.getElementById('b').onclick=async()=>{
  const token=qs('token');
  if(document.getElementById('p1').value!==document.getElementById('p2').value){
    document.getElementById('alert').innerHTML='<div class="alert alert-error">رمزها یکسان نیست</div>'; return;
  }
  try{
    await API.post('/api/auth/reset',{token,password:document.getElementById('p1').value});
    document.getElementById('alert').innerHTML='<div class="alert alert-success">رمز تغییر کرد — وارد شوید</div>';
    setTimeout(()=>location.href='/login',1200);
  }catch(e){ document.getElementById('alert').innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
};
