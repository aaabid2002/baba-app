const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-key-12345';

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/baba')
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.log('❌ MongoDB error:', err.message));

const User = mongoose.model('User', new mongoose.Schema({
  fullName: String,
  phone: { type: String, unique: true },
  password: String,
  wilaya: String,
  role: { type: String, default: 'marketer' },
  balance: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
}));

const Product = mongoose.model('Product', new mongoose.Schema({
  name: String,
  description: String,
  wholesalePrice: Number,
  suggestedPrice: Number,
  stock: Number,
  category: String,
  isActive: { type: Boolean, default: true }
}));

const Order = mongoose.model('Order', new mongoose.Schema({
  orderNumber: { type: String, unique: true },
  marketer: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  customer: { fullName: String, phone: String, wilaya: String, address: String },
  items: [{ productName: String, quantity: Number, sellingPrice: Number, commission: Number }],
  total: Number,
  totalCommission: Number,
  status: { type: String, default: 'pending' },
  createdAt: { type: Date, default: Date.now }
}));

const auth = async (req, res, next) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ success: false, message: 'غير مصرح' });
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = await User.findById(decoded.id);
    if (!req.user) return res.status(401).json({ success: false, message: 'غير مصرح' });
    next();
  } catch (e) {
    res.status(401).json({ success: false, message: 'جلسة منتهية' });
  }
};

app.post('/api/auth/register', async (req, res) => {
  try {
    const { fullName, phone, password, wilaya } = req.body;
    if (!fullName || !phone || !password || !wilaya) {
      return res.status(400).json({ success: false, message: 'كل الحقول مطلوبة' });
    }
    const exists = await User.findOne({ phone });
    if (exists) return res.status(400).json({ success: false, message: 'رقم الهاتف مسجل' });
    const user = await User.create({
      fullName, phone, wilaya,
      password: await bcrypt.hash(password, 10)
    });
    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    const user = await User.findOne({ phone });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ success: false, message: 'بيانات غير صحيحة' });
    }
    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get('/api/me', auth, (req, res) => {
  res.json({
    success: true,
    user: {
      id: req.user._id,
      fullName: req.user.fullName,
      phone: req.user.phone,
      wilaya: req.user.wilaya,
      balance: req.user.balance
    }
  });
});

app.get('/api/products', async (req, res) => {
  const products = await Product.find({ isActive: true }).limit(50);
  res.json({ success: true, products });
});

app.post('/api/orders', auth, async (req, res) => {
  try {
    const { customer, items } = req.body;
    if (!customer?.fullName || !items?.length) {
      return res.status(400).json({ success: false, message: 'بيانات ناقصة' });
    }
    const orderNumber = 'BBA-' + Date.now().toString().slice(-8);
    let total = 0, totalCommission = 0;
    for (const item of items) {
      const product = await Product.findById(item.product);
      if (!product) continue;
      const commission = (item.sellingPrice - product.wholesalePrice) * item.quantity;
      total += item.sellingPrice * item.quantity;
      totalCommission += commission;
      item.productName = product.name;
      item.commission = commission;
    }
    const order = await Order.create({
      orderNumber, marketer: req.user._id,
      customer, items, total, totalCommission
    });
    await User.updateOne({ _id: req.user._id }, { $inc: { balance: totalCommission } });
    res.json({ success: true, order });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get('/api/my-orders', auth, async (req, res) => {
  const orders = await Order.find({ marketer: req.user._id }).sort('-createdAt').limit(50);
  res.json({ success: true, orders });
});

app.get('/api/stats', auth, async (req, res) => {
  const orders = await Order.find({ marketer: req.user._id });
  res.json({
    success: true,
    stats: {
      balance: req.user.balance,
      totalOrders: orders.length,
      totalSales: orders.reduce((s, o) => s + o.total, 0),
      totalCommission: orders.reduce((s, o) => s + o.totalCommission, 0)
    }
  });
});

const PAGE_INDEX = '<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Grossistes.Online</title><link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;700;800;900&display=swap" rel="stylesheet"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Tajawal,sans-serif;background:#0a0c10;color:#eef2f6;direction:rtl;min-height:100vh;padding:20px}.container{max-width:480px;margin:0 auto}.logo{text-align:center;font-size:1.8rem;font-weight:900;background:linear-gradient(135deg,#fff,#ffa733);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin:32px 0 8px}.tag{text-align:center;color:#a0b0c4;margin-bottom:32px}.card{background:linear-gradient(145deg,#13171e,#0b0d10);border:1px solid rgba(255,140,0,.25);border-radius:20px;padding:24px}.tabs{display:flex;gap:6px;margin-bottom:20px;background:rgba(255,255,255,.03);border-radius:12px;padding:4px}.tab{flex:1;padding:10px;background:transparent;border:none;color:#a0b0c4;font-family:inherit;font-weight:700;cursor:pointer;border-radius:8px;font-size:.9rem}.tab.active{background:linear-gradient(135deg,#1a5490,#ff8c00);color:#fff}.fg{margin-bottom:14px}.fg label{display:block;font-size:.85rem;color:#a0b0c4;margin-bottom:6px;font-weight:700}.fc{width:100%;padding:14px 16px;background:rgba(255,255,255,.04);border:1.5px solid rgba(255,255,255,.08);border-radius:12px;color:#fff;font-family:inherit;font-size:1rem;outline:none}.fc:focus{border-color:#ff8c00}.btn{width:100%;padding:16px;background:linear-gradient(135deg,#1a5490,#ff8c00);color:#fff;border:none;border-radius:12px;font-family:inherit;font-weight:800;font-size:1rem;cursor:pointer;margin-top:8px}.err{color:#f87171;text-align:center;font-size:.85rem;margin-top:12px;display:none}</style></head><body><div class="container"><div class="logo">📦 Grossistes.Online</div><div class="tag">تسويق بالعمولة بأسعار الجملة</div><div class="card"><div class="tabs"><button class="tab active" id="tr" onclick="tab(\'r\')">تسجيل جديد</button><button class="tab" id="tl" onclick="tab(\'l\')">دخول</button></div><form id="fr" onsubmit="reg(event)"><div class="fg"><label>الاسم الكامل</label><input class="fc" id="rn" required></div><div class="fg"><label>رقم الهاتف</label><input class="fc" id="rp" type="tel" required></div><div class="fg"><label>الولاية</label><input class="fc" id="rw" required></div><div class="fg"><label>كلمة المرور</label><input class="fc" id="rpw" type="password" required minlength="6"></div><button class="btn">سجل الآن</button><div class="err" id="er"></div></form><form id="fl" style="display:none" onsubmit="log(event)"><div class="fg"><label>رقم الهاتف</label><input class="fc" id="lp" type="tel" required></div><div class="fg"><label>كلمة المرور</label><input class="fc" id="lpw" type="password" required></div><button class="btn">تسجيل الدخول</button><div class="err" id="el"></div></form></div></div><script>const API=location.origin+"/api";function tab(t){tr.classList.toggle("active",t==="r");tl.classList.toggle("active",t==="l");fr.style.display=t==="r"?"block":"none";fl.style.display=t==="l"?"block":"none"}async function reg(e){e.preventDefault();er.style.display="none";try{const r=await fetch(API+"/auth/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({fullName:rn.value,phone:rp.value,wilaya:rw.value,password:rpw.value})});const d=await r.json();if(!d.success)throw new Error(d.message);localStorage.setItem("t",d.token);location.href="/dashboard"}catch(e){er.textContent=e.message;er.style.display="block"}}async function log(e){e.preventDefault();el.style.display="none";try{const r=await fetch(API+"/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({phone:lp.value,password:lpw.value})});const d=await r.json();if(!d.success)throw new Error(d.message);localStorage.setItem("t",d.token);location.href="/dashboard"}catch(e){el.textContent=e.message;el.style.display="block"}}</script></body></html>';

const PAGE_DASH = '<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>لوحة التحكم</title><link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;700;800;900&display=swap" rel="stylesheet"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Tajawal,sans-serif;background:#0a0c10;color:#eef2f6;direction:rtl;padding:20px}.container{max-width:800px;margin:0 auto}.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;padding:16px;background:linear-gradient(145deg,#13171e,#0b0d10);border-radius:16px}.logo{font-weight:900;font-size:1.15rem}.btn{padding:10px 20px;background:transparent;border:1.5px solid rgba(255,255,255,.15);color:#fff;border-radius:40px;font-family:inherit;font-weight:700;cursor:pointer}.stats{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:20px}.stat{background:linear-gradient(145deg,#13171e,#0b0d10);border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:16px}.sv{font-size:1.4rem;font-weight:900;background:linear-gradient(135deg,#fff,#ffa733);-webkit-background-clip:text;-webkit-text-fill-color:transparent}.sl{font-size:.78rem;color:#6a7a8a;margin-top:4px}.card{background:linear-gradient(145deg,#13171e,#0b0d10);border:1px solid rgba(255,255,255,.06);border-radius:16px;padding:20px;margin-bottom:16px}.card h2{font-size:1.05rem;margin-bottom:14px}.prod{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}.p{background:rgba(26,84,144,.1);border:1px solid rgba(26,84,144,.25);border-radius:12px;padding:12px}.p h3{font-size:.85rem;margin-bottom:6px}.pp{color:#ffa733;font-weight:800;font-size:1rem}.pc{color:#4ade80;font-size:.72rem;font-weight:700;margin-bottom:8px}.p button{width:100%;padding:8px;background:linear-gradient(135deg,#1a5490,#ff8c00);color:#fff;border:none;border-radius:8px;font-family:inherit;font-weight:700;cursor:pointer;font-size:.85rem}.order{background:rgba(255,255,255,.03);border-radius:10px;padding:12px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center}.on{color:#7dd3fc;font-weight:700;font-size:.82rem}.oc{color:#a0b0c4;font-size:.75rem}.oa{color:#4ade80;font-weight:800;font-size:.9rem}.empty{text-align:center;padding:30px;color:#6a7a8a;font-size:.9rem}.modal{position:fixed;inset:0;background:rgba(0,0,0,.85);display:none;align-items:center;justify-content:center;padding:20px;z-index:999}.modal.active{display:flex}.mb{background:linear-gradient(145deg,#13171e,#0b0d10);border:1px solid rgba(255,140,0,.3);border-radius:18px;padding:24px;max-width:400px;width:100%;max-height:90vh;overflow-y:auto}.mb h2{margin-bottom:16px;font-size:1.15rem}.fg{margin-bottom:12px}.fg label{display:block;font-size:.8rem;color:#a0b0c4;margin-bottom:4px;font-weight:700}.fc{width:100%;padding:12px;background:rgba(255,255,255,.04);border:1.5px solid rgba(255,255,255,.08);border-radius:10px;color:#fff;font-family:inherit;outline:none;font-size:.95rem}.fc:focus{border-color:#ff8c00}</style></head><body><div class="container"><div class="header"><div class="logo">📦 Grossistes.Online</div><button class="btn" onclick="logout()">خروج</button></div><h2 style="margin-bottom:16px" id="welcome">مرحباً</h2><div class="stats" id="stats"></div><div class="card"><h2>📦 المنتجات</h2><div class="prod" id="prod">جاري التحميل...</div></div><div class="card"><h2>🛒 طلباتي</h2><div id="orders"><div class="empty">لا توجد طلبات</div></div></div></div><div class="modal" id="modal"><div class="mb"><h2>طلب جديد</h2><form onsubmit="createOrder(event)"><input type="hidden" id="pid"><input type="hidden" id="sprice"><div class="fg"><label>المنتج</label><input class="fc" id="pname" readonly></div><div class="fg"><label>اسم الزبون</label><input class="fc" id="cn" required></div><div class="fg"><label>الهاتف</label><input class="fc" id="cp" type="tel" required></div><div class="fg"><label>الولاية</label><input class="fc" id="cw" required></div><div class="fg"><label>العنوان</label><input class="fc" id="ca" required></div><div class="fg"><label>الكمية</label><input class="fc" id="qty" type="number" value="1" min="1"></div><button class="btn" style="width:100%;background:linear-gradient(135deg,#1a5490,#ff8c00);border:none;padding:14px">تأكيد</button><button type="button" class="btn" style="width:100%;margin-top:8px" onclick="closeModal()">إلغاء</button></form></div></div><script>const API=location.origin+"/api";const T=localStorage.getItem("t");if(!T)location.href="/";const H={"Content-Type":"application/json","Authorization":"Bearer "+T};async function load(){try{const[me,st,pr,or]=await Promise.all([fetch(API+"/me",{headers:H}).then(r=>r.json()),fetch(API+"/stats",{headers:H}).then(r=>r.json()),fetch(API+"/products").then(r=>r.json()),fetch(API+"/my-orders",{headers:H}).then(r=>r.json())]);if(me.user)welcome.textContent="مرحباً "+me.user.fullName;if(st.stats)stats.innerHTML=`<div class="stat"><div class="sv">${st.stats.balance.toLocaleString()} دج</div><div class="sl">الرصيد</div></div><div class="stat"><div class="sv">${st.stats.totalOrders}</div><div class="sl">الطلبات</div></div><div class="stat"><div class="sv">${st.stats.totalSales.toLocaleString()}</div><div class="sl">المبيعات</div></div><div class="stat"><div class="sv">${st.stats.totalCommission.toLocaleString()}</div><div class="sl">العمولات</div></div>`;if(pr.products)prod.innerHTML=pr.products.map(p=>`<div class="p"><h3>${p.name}</h3><div class="pp">${p.suggestedPrice} دج</div><div class="pc">+ ${p.suggestedPrice-p.wholesalePrice} دج</div><button onclick=\'om("${p._id}","${p.name.replace(/"/g,"")}",${p.suggestedPrice})\'>اطلب</button></div>`).join("");if(or.orders&&or.orders.length)orders.innerHTML=or.orders.map(o=>`<div class="order"><div><div class="on">${o.orderNumber}</div><div class="oc">${o.customer.fullName} — ${o.customer.wilaya}</div></div><div class="oa">+${o.totalCommission} دج</div></div>`).join("")}catch(e){console.error(e)}}function om(id,name,price){pid.value=id;pname.value=name;sprice.value=price;modal.classList.add("active")}function closeModal(){modal.classList.remove("active")}async function createOrder(e){e.preventDefault();try{const r=await fetch(API+"/orders",{method:"POST",headers:H,body:JSON.stringify({customer:{fullName:cn.value,phone:cp.value,wilaya:cw.value,address:ca.value},items:[{product:pid.value,quantity:+qty.value,sellingPrice:+sprice.value}]})});const d=await r.json();if(!d.success)throw new Error(d.message);alert("✅ تم إنشاء الطلب");closeModal();load()}catch(e){alert(e.message)}}function logout(){localStorage.removeItem("t");location.href="/"}load()</script></body></html>';

app.get('/', (req, res) => res.send(PAGE_INDEX));
app.get('/dashboard', (req, res) => res.send(PAGE_DASH));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

async function seed() {
  const count = await Product.countDocuments();
  if (count > 0) return;
  await Product.insertMany([
    { name: 'ساعة ذكية', description: 'ساعة بشاشة لمس', wholesalePrice: 2000, suggestedPrice: 3500, stock: 100, category: 'electronics' },
    { name: 'سماعات بلوتوث', description: 'سماعات لاسلكية', wholesalePrice: 1500, suggestedPrice: 2800, stock: 150, category: 'electronics' },
    { name: 'حقيبة ظهر', description: 'حقيبة مقاومة للماء', wholesalePrice: 1200, suggestedPrice: 2200, stock: 80, category: 'fashion' },
    { name: 'عطر رجالي', description: 'عطر شرقي', wholesalePrice: 1800, suggestedPrice: 3200, stock: 200, category: 'beauty' },
    { name: 'مكنسة محمولة', description: 'مكنسة لاسلكية', wholesalePrice: 2500, suggestedPrice: 4500, stock: 60, category: 'home' }
  ]);
  console.log('✅ Products seeded');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('🚀 Server running on port ' + PORT);
  setTimeout(seed, 2000);
});