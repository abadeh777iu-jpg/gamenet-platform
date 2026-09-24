module.exports = { create(){ return { run(f, ...a){ return f(...a); }, on(){}, add(){}, remove(){} }; }, createDomain(){ return module.exports.create(); } };
