const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const https = require('https');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('public'));

// ═══ Config ═══
const JWT_SECRET = process.env.JWT_SECRET || 'baba-secret-key-2025';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/baba';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const PORT = process.env.PORT || 3000;

// ═══ Upload directory ═══
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, Date.now() + '-' + Math.random().toString(36).slice(2) + ext);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('صيغة غير مدعومة'));
  }
});

// ═══ Database ═══
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(e => console.log('❌ DB error:', e.message));

// ═══ Models ═══
const User = mongoose.model('User', new mongoose.Schema({
  fullName: { type: String, required: true },
  phone: { type: String, required: true, unique: true },
  email: String,
  password: { type: String, required: true },
  wilaya: String,
  role: { type: String, default: 'marketer' },
  balance: { type: Number, default: 0 },
  pendingBalance: { type: Number, default: 0 },
  totalSales: { type: Number, default: 0 },
  totalOrders: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
}));

const Product = mongoose.model('Product', new mongoose.Schema({
  name: { type: String, required: true },
  description: String,
  image: String,
  gallery: [String],
  category: { type: String, default: 'general' },
  wholesalePrice: { type: Number, required: true },
  suggestedPrice: { type: Number, required: true },
  stock: { type: Number, default: 100 },
  sold: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
}));

const Order = mongoose.model('Order', new mongoose.Schema({
  orderNumber: { type: String, unique: true },
  marketer: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  customer: {
    fullName: String,
    phone: String,
    wilaya: String,
    address: String
  },
  items: [{
    productId: mongoose.Schema.Types.ObjectId,
    productName: String,
    quantity: Number,
    wholesalePrice: Number,
    sellingPrice: Number,
    commission: Number
  }],
  total: Number,
  totalCommission: Number,
  deliveryFee: { type: Number, default: 0 },
  status: { type: String, default: 'pending' },
  createdAt: { type: Date, default: Date.now }
}));

const Withdrawal = mongoose.model('Withdrawal', new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  amount: Number,
  method: { type: String, default: 'ccp' },
  accountNumber: String,
  accountHolder: String,
  status: { type: String, default: 'pending' },
  createdAt: { type: Date, default: Date.now }
}));

// ═══ Auth middleware ═══
const auth = async (req, res, next) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'غير مصرح' });
    const d = jwt.verify(token, JWT_SECRET);
    req.user = await User.findById(d.id);
    if (!req.user || !req.user.isActive) return res.status(401).json({ error: 'جلسة منتهية' });
    next();
  } catch {
    res.status(401).json({ error: 'جلسة منتهية' });
  }
};

const adminOnly = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'غير مصرح' });
  next();
};

// ═══ AI Helper (Groq — مجاني) ═══
async function askAI(prompt) {
  if (!GROQ_API_KEY) return null;
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 500
    });
    const req = https.request({
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + GROQ_API_KEY,
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        try {
          const d = JSON.parse(chunks);
          resolve(d.choices?.[0]?.message?.content || null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════

app.post('/api/auth/register', async (req, res) => {
  try {
    const { fullName, phone, password, wilaya, email } = req.body;
    if (!fullName || !phone || !password || !wilaya) {
      return res.status(400).json({ error: 'كل الحقول مطلوبة' });
    }
    if (password.length < 6) return res.status(400).json({ error: 'كلمة المرور قصيرة' });
    if (await User.findOne({ phone })) return res.status(400).json({ error: 'رقم الهاتف مسجل' });

    const user = await User.create({
      fullName, phone, email, wilaya,
      password: await bcrypt.hash(password, 10)
    });

    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, user: { id: user._id, fullName, role: user.role } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    const user = await User.findOne({ phone });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'بيانات خاطئة' });
    }
    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, user: { id: user._id, fullName: user.fullName, role: user.role } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/auth/me', auth, (req, res) => {
  res.json({ success: true, user: req.user });
});

// ═══════════════════════════════════════════════════════
// PRODUCTS
// ═══════════════════════════════════════════════════════

app.get('/api/products', auth, async (req, res) => {
  const products = await Product.find({ isActive: true }).sort('-createdAt').limit(100);
  res.json({ success: true, products });
});

app.post('/api/products', auth, adminOnly, upload.single('image'), async (req, res) => {
  try {
    const data = { ...req.body };
    if (req.file) data.image = '/uploads/' + req.file.filename;
    const product = await Product.create(data);
    res.json({ success: true, product });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/products/:id', auth, adminOnly, async (req, res) => {
  const product = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true });
  res.json({ success: true, product });
});

app.delete('/api/products/:id', auth, adminOnly, async (req, res) => {
  await Product.findByIdAndUpdate(req.params.id, { isActive: false });
  res.json({ success: true });
});

// AI Description Generator (مجاني عبر Groq)
app.post('/api/products/generate-description', auth, adminOnly, async (req, res) => {
  const { name, category } = req.body;
  if (!name) return res.status(400).json({ error: 'اسم المنتج مطلوب' });

  const prompt = `اكتب وصف تسويقي احترافي بالعربية (لهجة جزائرية جزئياً) لمنتج اسمه "${name}" فئة "${category || 'عام'}".
الوصف يجب أن يكون:
- من 3 جمل
- يذكر الفوائد
- يشجع على الشراء
- بدون ذكر السعر

اكتب الوصف فقط بدون أي مقدمات.`;

  const description = await askAI(prompt);
  if (!description) return res.status(503).json({ error: 'AI غير متاح حالياً' });

  res.json({ success: true, description: description.trim() });
});

// ═══════════════════════════════════════════════════════
// ORDERS
// ═══════════════════════════════════════════════════════

app.post('/api/orders', auth, async (req, res) => {
  try {
    const { customer, items, deliveryFee = 0 } = req.body;
    if (!customer?.fullName || !customer?.phone || !items?.length) {
      return res.status(400).json({ error: 'بيانات ناقصة' });
    }

    let total = 0, totalCommission = 0;
    const orderItems = [];

    for (const item of items) {
      const product = await Product.findById(item.productId);
      if (!product) continue;
      if (product.stock < item.quantity) continue;

      const sellingPrice = item.sellingPrice || product.suggestedPrice;
      const commission = (sellingPrice - product.wholesalePrice) * item.quantity;

      orderItems.push({
        productId: product._id,
        productName: product.name,
        quantity: item.quantity,
        wholesalePrice: product.wholesalePrice,
        sellingPrice,
        commission
      });

      total += sellingPrice * item.quantity;
      totalCommission += commission;

      product.stock -= item.quantity;
      product.sold += item.quantity;
      await product.save();
    }

    if (!orderItems.length) return res.status(400).json({ error: 'لا توجد منتجات صالحة' });

    const order = await Order.create({
      orderNumber: 'BBA-' + Date.now().toString().slice(-8),
      marketer: req.user._id,
      customer, items: orderItems,
      total: total + deliveryFee,
      totalCommission,
      deliveryFee
    });

    await User.updateOne(
      { _id: req.user._id },
      { $inc: { pendingBalance: totalCommission, totalOrders: 1 } }
    );

    res.json({ success: true, order });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/orders/my', auth, async (req, res) => {
  const orders = await Order.find({ marketer: req.user._id }).sort('-createdAt').limit(100);
  res.json({ success: true, orders });
});

app.get('/api/orders', auth, adminOnly, async (req, res) => {
  const orders = await Order.find().sort('-createdAt').limit(200).populate('marketer', 'fullName phone');
  res.json({ success: true, orders });
});

app.put('/api/orders/:id/status', auth, adminOnly, async (req, res) => {
  try {
    const { status } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'غير موجود' });

    const prev = order.status;
    order.status = status;
    await order.save();

    if (status === 'delivered' && prev !== 'delivered') {
      await User.updateOne(
        { _id: order.marketer },
        {
          $inc: {
            balance: order.totalCommission,
            pendingBalance: -order.totalCommission,
            totalSales: order.total
          }
        }
      );
    }

    if ((status === 'cancelled' || status === 'returned') && prev !== status) {
      await User.updateOne(
        { _id: order.marketer },
        { $inc: { pendingBalance: -order.totalCommission } }
      );
    }

    res.json({ success: true, order });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════

app.get('/api/stats/my', auth, async (req, res) => {
  const orders = await Order.find({ marketer: req.user._id });
  res.json({
    success: true,
    stats: {
      balance: req.user.balance,
      pendingBalance: req.user.pendingBalance,
      totalOrders: orders.length,
      totalSales: req.user.totalSales,
      delivered: orders.filter(o => o.status === 'delivered').length,
      pending: orders.filter(o => o.status === 'pending').length
    }
  });
});

app.get('/api/stats/admin', auth, adminOnly, async (req, res) => {
  const [users, products, orders] = await Promise.all([
    User.countDocuments({ role: 'marketer' }),
    Product.countDocuments({ isActive: true }),
    Order.find()
  ]);
  res.json({
    success: true,
    stats: {
      totalUsers: users,
      totalProducts: products,
      totalOrders: orders.length,
      totalRevenue: orders.filter(o => o.status === 'delivered').reduce((s, o) => s + o.total, 0),
      pendingOrders: orders.filter(o => o.status === 'pending').length
    }
  });
});

// ═══════════════════════════════════════════════════════
// WITHDRAWALS
// ═══════════════════════════════════════════════════════

app.post('/api/withdrawals', auth, async (req, res) => {
  try {
    const { amount, method, accountNumber, accountHolder } = req.body;
    if (!amount || amount < 1000) return res.status(400).json({ error: 'الحد الأدنى 1000 دج' });
    if (req.user.balance < amount) return res.status(400).json({ error: 'الرصيد غير كافٍ' });

    const w = await Withdrawal.create({
      user: req.user._id, amount, method, accountNumber, accountHolder
    });

    await User.updateOne({ _id: req.user._id }, { $inc: { balance: -amount } });
    res.json({ success: true, withdrawal: w });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/withdrawals/my', auth, async (req, res) => {
  const w = await Withdrawal.find({ user: req.user._id }).sort('-createdAt');
  res.json({ success: true, withdrawals: w });
});

app.get('/api/withdrawals', auth, adminOnly, async (req, res) => {
  const w = await Withdrawal.find().sort('-createdAt').populate('user', 'fullName phone');
  res.json({ success: true, withdrawals: w });
});

app.put('/api/withdrawals/:id', auth, adminOnly, async (req, res) => {
  try {
    const { status, reason } = req.body;
    const w = await Withdrawal.findById(req.params.id);
    if (!w) return res.status(404).json({ error: 'غير موجود' });

    if (status === 'rejected' && w.status !== 'rejected') {
      await User.updateOne({ _id: w.user }, { $inc: { balance: w.amount } });
    }
    w.status = status;
    await w.save();
    res.json({ success: true, withdrawal: w });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════
// USERS (Admin)
// ═══════════════════════════════════════════════════════

app.get('/api/users', auth, adminOnly, async (req, res) => {
  const users = await User.find({ role: 'marketer' }).sort('-createdAt').limit(200);
  res.json({ success: true, users });
});

app.put('/api/users/:id/toggle', auth, adminOnly, async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'غير موجود' });
  user.isActive = !user.isActive;
  await user.save();
  res.json({ success: true, user });
});

// ═══════════════════════════════════════════════════════
// SEED DEMO DATA
// ═══════════════════════════════════════════════════════

async function seed() {
  if (await Product.countDocuments() > 0) return;

  await Product.insertMany([
    { name: 'ساعة ذكية Smart Watch', description: 'ساعة بشاشة لمس، بطارية أسبوع', wholesalePrice: 2000, suggestedPrice: 3500, stock: 100, category: 'electronics' },
    { name: 'سماعات بلوتوث', description: 'سماعات لاسلكية بجودة عالية', wholesalePrice: 1500, suggestedPrice: 2800, stock: 150, category: 'electronics' },
    { name: 'حقيبة ظهر عصرية', description: 'حقيبة مقاومة للماء مع USB', wholesalePrice: 1200, suggestedPrice: 2200, stock: 80, category: 'fashion' },
    { name: 'عطر رجالي فاخر', description: 'عطر شرقي بثبات طويل', wholesalePrice: 1800, suggestedPrice: 3200, stock: 200, category: 'beauty' },
    { name: 'مكنسة كهربائية محمولة', description: 'مكنسة لاسلكية خفيفة', wholesalePrice: 2500, suggestedPrice: 4500, stock: 60, category: 'home' }
  ]);

  if (!await User.findOne({ phone: '0555000000' })) {
    await User.create({
      fullName: 'المدير العام',
      phone: '0555000000',
      password: await bcrypt.hash('admin123', 10),
      wilaya: 'الجزائر',
      role: 'admin'
    });
    console.log('✅ Admin: 0555000000 / admin123');
  }

  console.log('✅ Demo data seeded');
}

// ═══════════════════════════════════════════════════════
// FRONTEND (HTML in JS)
// ═══════════════════════════════════════════════════════

app.get('/', (req, res) => res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Grossistes.Online</title>
<link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;700;800;900&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Tajawal,sans-serif;background:linear-gradient(135deg,#0a0c10,#0f1a2e,#0a0c10);color:#eef2f6;direction:rtl;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.box{background:linear-gradient(145deg,#13171e,#0b0d10);border:1px solid rgba(255,140,0,.3);border-radius:24px;padding:36px 28px;max-width:440px;width:100%;box-shadow:0 30px 60px rgba(0,0,0,.5)}
.logo{text-align:center;font-size:2rem;font-weight:900;background:linear-gradient(135deg,#fff,#ffa733);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:8px}
.sub{text-align:center;color:#a0b0c4;margin-bottom:28px;font-size:.95rem}
.tabs{display:flex;gap:6px;margin-bottom:24px;background:rgba(255,255,255,.03);border-radius:14px;padding:5px}
.tab{flex:1;padding:12px;background:transparent;border:none;color:#a0b0c4;font-family:inherit;font-weight:700;cursor:pointer;border-radius:10px;font-size:.9rem;transition:.2s}
.tab.on{background:linear-gradient(135deg,#1a5490,#ff8c00);color:#fff}
input{width:100%;padding:14px 16px;background:rgba(255,255,255,.04);border:1.5px solid rgba(255,255,255,.08);border-radius:12px;color:#fff;font-family:inherit;font-size:1rem;margin-bottom:12px;outline:none;transition:.2s}
input:focus{border-color:#ff8c00;background:rgba(255,140,0,.05)}
button.submit{width:100%;padding:16px;background:linear-gradient(135deg,#1a5490,#ff8c00);color:#fff;border:none;border-radius:12px;font-family:inherit;font-weight:800;font-size:1rem;cursor:pointer;margin-top:8px;transition:.2s;box-shadow:0 8px 24px rgba(255,140,0,.3)}
button.submit:hover{transform:translateY(-2px);box-shadow:0 12px 32px rgba(255,140,0,.5)}
.err{color:#f87171;text-align:center;font-size:.85rem;margin-top:12px;min-height:20px}
.demo{margin-top:20px;padding:12px;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.3);border-radius:10px;color:#4ade80;font-size:.8rem;text-align:center}
</style>
</head>
<body>
<div class="box">
<div class="logo">📦 Grossistes.Online</div>
<div class="sub">تسويق بالعمولة بأسعار الجملة</div>
<div class="tabs">
<button class="tab on" id="t1" onclick="sw(1)">تسجيل جديد</button>
<button class="tab" id="t2" onclick="sw(2)">دخول</button>
</div>
<form id="f1" onsubmit="reg(event)">
<input id="rn" placeholder="الاسم الكامل" required>
<input id="rp" placeholder="رقم الهاتف (10 أرقام)" required>
<input id="rw" placeholder="الولاية" required>
<input id="rpass" type="password" placeholder="كلمة المرور (6+ أحرف)" required minlength="6">
<button class="submit">إنشاء الحساب مجاناً</button>
</form>
<form id="f2" style="display:none" onsubmit="log(event)">
<input id="lp" placeholder="رقم الهاتف" required>
<input id="lpass" type="password" placeholder="كلمة المرور" required>
<button class="submit">تسجيل الدخول</button>
</form>
<div class="err" id="e"></div>
<div class="demo">🔑 للتجربة كمدير: 0555000000 / admin123</div>
</div>
<script>
const A=location.origin+'/api';
function sw(n){t1.classList.toggle('on',n===1);t2.classList.toggle('on',n===2);f1.style.display=n===1?'block':'none';f2.style.display=n===2?'block':'none';e.textContent=''}
async function reg(ev){ev.preventDefault();e.textContent='';
try{const r=await fetch(A+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fullName:rn.value,phone:rp.value.replace(/\\s/g,''),wilaya:rw.value,password:rpass.value})});
const d=await r.json();if(!d.success)throw new Error(d.error);
localStorage.setItem('t',d.token);localStorage.setItem('u',JSON.stringify(d.user));
location.href=d.user.role==='admin'?'/admin':'/dash'}catch(x){e.textContent=x.message}}
async function log(ev){ev.preventDefault();e.textContent='';
try{const r=await fetch(A+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:lp.value.replace(/\\s/g,''),password:lpass.value})});
const d=await r.json();if(!d.success)throw new Error(d.error);
localStorage.setItem('t',d.token);localStorage.setItem('u',JSON.stringify(d.user));
location.href=d.user.role==='admin'?'/admin':'/dash'}catch(x){e.textContent=x.message}}
</script>
</body>
</html>`));

// ═══ MARKETER DASHBOARD ═══
app.get('/dash', (req, res) => res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>لوحة التحكم</title>
<link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;700;800;900&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Tajawal,sans-serif;background:#0a0c10;color:#eef2f6;direction:rtl;padding:16px}
.w{max-width:900px;margin:0 auto}
.h{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;background:linear-gradient(145deg,#13171e,#0b0d10);border-radius:16px;margin-bottom:16px;border:1px solid rgba(255,255,255,.06)}
.logo{font-weight:900;font-size:1.1rem}
.ho{padding:8px 16px;background:transparent;border:1.5px solid rgba(255,255,255,.15);color:#fff;border-radius:40px;font-family:inherit;font-weight:700;cursor:pointer;font-size:.85rem}
h1{font-size:1.3rem;margin-bottom:16px}
.stats{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:20px}
.s{background:linear-gradient(145deg,#13171e,#0b0d10);border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:16px}
.sv{font-size:1.4rem;font-weight:900;background:linear-gradient(135deg,#fff,#ffa733);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.sl{font-size:.78rem;color:#6a7a8a;margin-top:2px}
.c{background:linear-gradient(145deg,#13171e,#0b0d10);border:1px solid rgba(255,255,255,.06);border-radius:16px;padding:20px;margin-bottom:16px}
.c h2{font-size:1.05rem;margin-bottom:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}
.p{background:linear-gradient(145deg,rgba(26,84,144,.15),rgba(26,84,144,.05));border:1px solid rgba(26,84,144,.3);border-radius:14px;padding:14px;transition:.2s}
.p:hover{transform:translateY(-2px);border-color:rgba(255,140,0,.5)}
.p img{width:100%;height:120px;object-fit:cover;border-radius:10px;margin-bottom:10px}
.p h3{font-size:.9rem;margin-bottom:6px;font-weight:700}
.pp{color:#ffa733;font-weight:800;font-size:1.1rem}
.pc{color:#4ade80;font-size:.75rem;font-weight:700;margin-bottom:10px}
.p button{width:100%;padding:10px;background:linear-gradient(135deg,#1a5490,#ff8c00);color:#fff;border:none;border-radius:8px;font-family:inherit;font-weight:700;cursor:pointer;font-size:.85rem}
.o{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.05);border-radius:10px;padding:12px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;font-size:.85rem}
.on{color:#7dd3fc;font-weight:700;font-size:.8rem}
.oc{color:#6a7a8a;font-size:.75rem}
.oa{color:#4ade80;font-weight:800}
.badge{padding:3px 10px;border-radius:40px;font-size:.7rem;font-weight:700}
.b-pending{background:rgba(251,191,36,.15);color:#fbbf24}
.b-confirmed{background:rgba(59,130,246,.15);color:#60a5fa}
.b-shipped{background:rgba(139,92,246,.15);color:#a78bfa}
.b-delivered{background:rgba(16,185,129,.15);color:#4ade80}
.b-cancelled,.b-returned{background:rgba(239,68,68,.15);color:#f87171}
.empty{text-align:center;color:#6a7a8a;padding:30px;font-size:.9rem}
.m{position:fixed;inset:0;background:rgba(0,0,0,.85);display:none;align-items:center;justify-content:center;padding:16px;z-index:99;backdrop-filter:blur(4px)}
.m.on{display:flex}
.mb{background:linear-gradient(145deg,#13171e,#0b0d10);border:1px solid rgba(255,140,0,.3);border-radius:20px;padding:24px;max-width:420px;width:100%;max-height:90vh;overflow-y:auto}
.mb h2{margin-bottom:16px;font-size:1.15rem}
.mb input{width:100%;padding:12px;background:rgba(255,255,255,.04);border:1.5px solid rgba(255,255,255,.08);border-radius:10px;color:#fff;font-family:inherit;margin-bottom:10px;outline:none;font-size:.95rem}
.mb input:focus{border-color:#ff8c00}
.mb button{width:100%;padding:14px;background:linear-gradient(135deg,#1a5490,#ff8c00);color:#fff;border:none;border-radius:10px;font-family:inherit;font-weight:800;cursor:pointer;margin-bottom:8px;font-size:.95rem}
.mb button.alt{background:transparent;border:1.5px solid rgba(255,255,255,.15)}
</style>
</head>
<body>
<div class="w">
<div class="h">
<div class="logo">📦 Grossistes.Online</div>
<button class="ho" onclick="out()">خروج</button>
</div>
<h1 id="hi">مرحباً 👋</h1>
<div class="stats" id="stats"></div>
<div class="c">
<h2>📦 المنتجات المتاحة</h2>
<div class="grid" id="prods"><div class="empty">جاري التحميل...</div></div>
</div>
<div class="c">
<h2>🛒 طلباتي</h2>
<div id="ords"><div class="empty">لا توجد طلبات بعد</div></div>
</div>
</div>
<div class="m" id="m">
<div class="mb">
<h2>🛒 طلب جديد</h2>
<form onsubmit="mk(event)">
<input type="hidden" id="pid">
<input type="hidden" id="psp">
<input id="pn" readonly style="background:rgba(255,140,0,.1)">
<input id="cn" placeholder="اسم الزبون *" required>
<input id="cp" placeholder="رقم الهاتف *" required>
<input id="cw" placeholder="الولاية *" required>
<input id="ca" placeholder="العنوان الكامل *" required>
<input id="q" type="number" value="1" min="1" placeholder="الكمية">
<button>تأكيد الطلب</button>
<button type="button" class="alt" onclick="cm()">إلغاء</button>
</form>
</div>
</div>
<script>
const A=location.origin+'/api';
const T=localStorage.getItem('t');
if(!T)location.href='/';
const H={'Content-Type':'application/json','Authorization':'Bearer '+T};
const SL={pending:'قيد الانتظار',confirmed:'مؤكد',shipped:'تم الشحن',delivered:'تم التوصيل',cancelled:'ملغى',returned:'مرتجع'};
async function load(){
try{
const[me,st,pr,ord]=await Promise.all([
fetch(A+'/auth/me',{headers:H}).then(r=>r.json()),
fetch(A+'/stats/my',{headers:H}).then(r=>r.json()),
fetch(A+'/products',{headers:H}).then(r=>r.json()),
fetch(A+'/orders/my',{headers:H}).then(r=>r.json())
]);
if(me.user)hi.textContent='مرحباً '+me.user.fullName.split(' ')[0]+' 👋';
if(st.stats)stats.innerHTML=\`
<div class="s"><div class="sv">\${st.stats.balance.toLocaleString()}</div><div class="sl">الرصيد (دج)</div></div>
<div class="s"><div class="sv">\${st.stats.pendingBalance.toLocaleString()}</div><div class="sl">قيد التحصيل</div></div>
<div class="s"><div class="sv">\${st.stats.totalOrders}</div><div class="sl">الطلبات</div></div>
<div class="s"><div class="sv">\${st.stats.totalSales.toLocaleString()}</div><div class="sl">المبيعات</div></div>\`;
if(pr.products)prods.innerHTML=pr.products.map(p=>\`
<div class="p">
\${p.image?'<img src="'+p.image+'" alt="">':'<div style="height:120px;background:linear-gradient(135deg,#1a5490,#ff8c00);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:2rem;margin-bottom:10px">📦</div>'}
<h3>\${p.name}</h3>
<div class="pp">\${p.suggestedPrice} دج</div>
<div class="pc">+ \${p.suggestedPrice-p.wholesalePrice} دج عمولة</div>
<button onclick="op('\${p._id}','\${p.name.replace(/'/g,"")}',\${p.suggestedPrice})">اطلب الآن</button>
</div>\`).join('');
if(ord.orders&&ord.orders.length)ords.innerHTML=ord.orders.map(o=>\`
<div class="o">
<div><div class="on">\${o.orderNumber}</div><div class="oc">\${o.customer.fullName} — \${o.customer.wilaya}</div></div>
<div style="text-align:left"><div class="oa">+\${o.totalCommission} دج</div><div><span class="badge b-\${o.status}">\${SL[o.status]||o.status}</span></div></div>
</div>\`).join('');
}catch(e){console.log(e)}}
function op(id,name,price){pid.value=id;pn.value=name;psp.value=price;m.classList.add('on')}
function cm(){m.classList.remove('on')}
async function mk(e){e.preventDefault();
try{
const r=await fetch(A+'/orders',{method:'POST',headers:H,body:JSON.stringify({
customer:{fullName:cn.value,phone:cp.value,wilaya:cw.value,address:ca.value},
items:[{productId:pid.value,quantity:+q.value,sellingPrice:+psp.value}]
})});
const d=await r.json();if(!d.success)throw new Error(d.error);
alert('✅ تم إنشاء الطلب: '+d.order.orderNumber);cm();load();
}catch(x){alert('❌ '+x.message)}}
function out(){localStorage.clear();location.href='/'}
load();
</script>
</body>
</html>`));

// ═══ ADMIN DASHBOARD ═══
app.get('/admin', (req, res) => res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>لوحة الإدارة</title>
<link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;700;800;900&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Tajawal,sans-serif;background:#0a0c10;color:#eef2f6;direction:rtl;padding:16px}
.w{max-width:1000px;margin:0 auto}
.h{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;background:linear-gradient(145deg,#13171e,#0b0d10);border-radius:16px;margin-bottom:16px;border:1px solid rgba(255,255,255,.06)}
.logo{font-weight:900;font-size:1.1rem}
.ho{padding:8px 16px;background:transparent;border:1.5px solid rgba(255,255,255,.15);color:#fff;border-radius:40px;font-family:inherit;font-weight:700;cursor:pointer;font-size:.85rem}
.tabs{display:flex;gap:6px;margin-bottom:16px;background:rgba(255,255,255,.03);border-radius:14px;padding:5px;overflow-x:auto}
.tab{flex:1;min-width:100px;padding:12px 16px;background:transparent;border:none;color:#a0b0c4;font-family:inherit;font-weight:700;cursor:pointer;border-radius:10px;font-size:.85rem;white-space:nowrap}
.tab.on{background:linear-gradient(135deg,#1a5490,#ff8c00);color:#fff}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:20px}
.s{background:linear-gradient(145deg,#13171e,#0b0d10);border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:14px}
.sv{font-size:1.3rem;font-weight:900;color:#ffa733}
.sl{font-size:.75rem;color:#6a7a8a;margin-top:2px}
.c{background:linear-gradient(145deg,#13171e,#0b0d10);border:1px solid rgba(255,255,255,.06);border-radius:16px;padding:20px;margin-bottom:16px}
.c h2{font-size:1rem;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center}
.btn-sm{padding:6px 14px;background:linear-gradient(135deg,#1a5490,#ff8c00);color:#fff;border:none;border-radius:20px;font-family:inherit;font-weight:700;cursor:pointer;font-size:.78rem}
.tbl{width:100%;border-collapse:collapse;font-size:.82rem}
.tbl th,.tbl td{padding:10px;text-align:right;border-bottom:1px solid rgba(255,255,255,.05)}
.tbl th{color:#6a7a8a;font-weight:700;font-size:.75rem}
.tbl tr:hover{background:rgba(255,255,255,.02)}
.badge{padding:3px 10px;border-radius:40px;font-size:.68rem;font-weight:700;display:inline-block}
.b-pending{background:rgba(251,191,36,.15);color:#fbbf24}
.b-confirmed{background:rgba(59,130,246,.15);color:#60a5fa}
.b-shipped{background:rgba(139,92,246,.15);color:#a78bfa}
.b-delivered{background:rgba(16,185,129,.15);color:#4ade80}
.b-cancelled,.b-returned{background:rgba(239,68,68,.15);color:#f87171}
.b-active{background:rgba(16,185,129,.15);color:#4ade80}
.b-inactive{background:rgba(239,68,68,.15);color:#f87171}
.panel{display:none}
.panel.on{display:block}
select,input,textarea{width:100%;padding:10px 12px;background:rgba(255,255,255,.04);border:1.5px solid rgba(255,255,255,.08);border-radius:10px;color:#fff;font-family:inherit;font-size:.9rem;margin-bottom:10px;outline:none}
select:focus,input:focus,textarea:focus{border-color:#ff8c00}
label{display:block;color:#a0b0c4;font-size:.8rem;margin-bottom:6px;font-weight:700}
.actions{display:flex;gap:6px}
.icon-btn{width:32px;height:32px;border-radius:50%;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);color:#a0b0c4;cursor:pointer;font-size:.8rem;transition:.2s}
.icon-btn:hover{background:rgba(255,140,0,.15);color:#ff8c00}
.m{position:fixed;inset:0;background:rgba(0,0,0,.85);display:none;align-items:center;justify-content:center;padding:16px;z-index:99}
.m.on{display:flex}
.mb{background:linear-gradient(145deg,#13171e,#0b0d10);border:1px solid rgba(255,140,0,.3);border-radius:20px;padding:24px;max-width:440px;width:100%;max-height:90vh;overflow-y:auto}
.mb h2{margin-bottom:16px}
.mb button{width:100%;padding:14px;background:linear-gradient(135deg,#1a5490,#ff8c00);color:#fff;border:none;border-radius:10px;font-family:inherit;font-weight:800;cursor:pointer;margin-bottom:8px}
.mb button.alt{background:transparent;border:1.5px solid rgba(255,255,255,.15)}
</style>
</head>
<body>
<div class="w">
<div class="h">
<div class="logo">👑 Grossistes.Online — الإدارة</div>
<button class="ho" onclick="out()">خروج</button>
</div>

<div class="tabs">
<button class="tab on" onclick="pt(0)">📊 نظرة عامة</button>
<button class="tab" onclick="pt(1)">📦 المنتجات</button>
<button class="tab" onclick="pt(2)">🛒 الطلبات</button>
<button class="tab" onclick="pt(3)">👥 المسوّقون</button>
<button class="tab" onclick="pt(4)">💸 السحوبات</button>
</div>

<div class="panel on" id="p0">
<div class="stats" id="stats"></div>
</div>

<div class="panel" id="p1">
<div class="c">
<h2>📦 المنتجات <button class="btn-sm" onclick="openProductModal()">+ إضافة منتج</button></h2>
<div style="overflow-x:auto"><table class="tbl" id="prodTable"></table></div>
</div>
</div>

<div class="panel" id="p2">
<div class="c">
<h2>🛒 الطلبات</h2>
<div style="overflow-x:auto"><table class="tbl" id="orderTable"></table></div>
</div>
</div>

<div class="panel" id="p3">
<div class="c">
<h2>👥 المسوّقون</h2>
<div style="overflow-x:auto"><table class="tbl" id="userTable"></table></div>
</div>
</div>

<div class="panel" id="p4">
<div class="c">
<h2>💸 طلبات السحب</h2>
<div style="overflow-x:auto"><table class="tbl" id="wdTable"></table></div>
</div>
</div>

</div>

<div class="m" id="pm">
<div class="mb">
<h2 id="pmTitle">إضافة منتج</h2>
<form onsubmit="saveProduct(event)" enctype="multipart/form-data">
<input type="hidden" id="pmId">
<label>اسم المنتج *</label>
<input id="pmName" required>
<label>الوصف</label>
<textarea id="pmDesc" rows="2"></textarea>
<label>الصورة</label>
<input type="file" id="pmImage" accept="image/*">
<button type="button" class="btn-sm" onclick="genDesc()" style="margin-bottom:10px;width:100%">🤖 توليد وصف بالذكاء</button>
<label>الفئة</label>
<select id="pmCat">
<option value="electronics">إلكترونيات</option>
<option value="fashion">أزياء</option>
<option value="beauty">تجميل</option>
<option value="home">منزل</option>
<option value="general">عام</option>
</select>
<label>سعر الجملة *</label>
<input id="pmWhole" type="number" required>
<label>السعر المقترح *</label>
<input id="pmSug" type="number" required>
<label>المخزون</label>
<input id="pmStock" type="number" value="100">
<button type="submit">حفظ</button>
<button type="button" class="alt" onclick="cm()">إلغاء</button>
</form>
</div>
</div>

<script>
const A=location.origin+'/api';
const T=localStorage.getItem('t');
if(!T)location.href='/';
const U=JSON.parse(localStorage.getItem('u')||'{}');
if(U.role!=='admin')location.href='/dash';
const H={'Content-Type':'application/json','Authorization':'Bearer '+T};
const H2={'Authorization':'Bearer '+T};
const SL={pending:'قيد الانتظار',confirmed:'مؤكد',shipped:'تم الشحن',delivered:'تم التوصيل',cancelled:'ملغى',returned:'مرتجع'};

function pt(n){document.querySelectorAll('.tab').forEach((t,i)=>t.classList.toggle('on',i===n));document.querySelectorAll('.panel').forEach((p,i)=>p.classList.toggle('on',i===n));if(n===1)loadProducts();if(n===2)loadOrders();if(n===3)loadUsers();if(n===4)loadWd()}
function cm(){pm.classList.remove('on')}

async function loadStats(){
const r=await fetch(A+'/stats/admin',{headers:H}).then(r=>r.json());
if(!r.success)return;
const s=r.stats;
stats.innerHTML=\`
<div class="s"><div class="sv">\${s.totalUsers}</div><div class="sl">المسوّقون</div></div>
<div class="s"><div class="sv">\${s.totalProducts}</div><div class="sl">المنتجات</div></div>
<div class="s"><div class="sv">\${s.totalOrders}</div><div class="sl">الطلبات</div></div>
<div class="s"><div class="sv">\${s.totalRevenue.toLocaleString()}</div><div class="sl">الإيرادات (دج)</div></div>
<div class="s"><div class="sv">\${s.pendingOrders}</div><div class="sl">قيد الانتظار</div></div>
\`}

async function loadProducts(){
const r=await fetch(A+'/products',{headers:H}).then(r=>r.json());
if(!r.success)return;
prodTable.innerHTML=\`<tr><th>الاسم</th><th>الفئة</th><th>الجملة</th><th>المقترح</th><th>المخزون</th><th>إجراءات</th></tr>\`+
(r.products||[]).map(p=>\`<tr>
<td>\${p.name}</td><td>\${p.category}</td><td>\${p.wholesalePrice}</td><td>\${p.suggestedPrice}</td><td>\${p.stock}</td>
<td><div class="actions">
<button class="icon-btn" onclick='editProduct(\${JSON.stringify(p).replace(/'/g,"&#39;")})'>✏️</button>
<button class="icon-btn" onclick="delProduct('\${p._id}')">🗑️</button>
</div></td></tr>\`).join('')}

async function loadOrders(){
const r=await fetch(A+'/orders',{headers:H}).then(r=>r.json());
if(!r.success)return;
orderTable.innerHTML=\`<tr><th>رقم</th><th>المسوّق</th><th>الزبون</th><th>المجموع</th><th>الحالة</th><th>إجراء</th></tr>\`+
(r.orders||[]).map(o=>\`<tr>
<td>\${o.orderNumber}</td>
<td>\${o.marketer?.fullName||'—'}</td>
<td>\${o.customer.fullName}</td>
<td>\${o.total} دج</td>
<td><span class="badge b-\${o.status}">\${SL[o.status]||o.status}</span></td>
<td><select onchange="setStatus('\${o._id}',this.value)" style="padding:4px;font-size:.75rem">
\${Object.entries(SL).map(([k,v])=>\`<option value="\${k}" \${o.status===k?'selected':''}>\${v}</option>\`).join('')}
</select></td></tr>\`).join('')}

async function loadUsers(){
const r=await fetch(A+'/users',{headers:H}).then(r=>r.json());
if(!r.success)return;
userTable.innerHTML=\`<tr><th>الاسم</th><th>الهاتف</th><th>الولاية</th><th>الرصيد</th><th>الحالة</th><th>إجراء</th></tr>\`+
(r.users||[]).map(u=>\`<tr>
<td>\${u.fullName}</td><td>\${u.phone}</td><td>\${u.wilaya}</td>
<td>\${u.balance.toLocaleString()} دج</td>
<td><span class="badge \${u.isActive?'b-active':'b-inactive'}">\${u.isActive?'نشط':'معطّل'}</span></td>
<td><button class="icon-btn" onclick="toggleUser('\${u._id}')">\${u.isActive?'🚫':'✅'}</button></td></tr>\`).join('')}

async function loadWd(){
const r=await fetch(A+'/withdrawals',{headers:H}).then(r=>r.json());
if(!r.success)return;
wdTable.innerHTML=\`<tr><th>المستخدم</th><th>المبلغ</th><th>الطريقة</th><th>الحالة</th><th>إجراءات</th></tr>\`+
(r.withdrawals||[]).map(w=>\`<tr>
<td>\${w.user?.fullName||'—'}</td><td>\${w.amount} دج</td><td>\${w.method}</td>
<td><span class="badge b-\${w.status==='paid'?'delivered':w.status==='rejected'?'cancelled':'pending'}">\${w.status}</span></td>
<td><div class="actions">
\${w.status==='pending'?\`
<button class="icon-btn" onclick="setWd('\${w._id}','approved')" title="موافقة">✅</button>
<button class="icon-btn" onclick="setWd('\${w._id}','paid')" title="مدفوع">💵</button>
<button class="icon-btn" onclick="setWd('\${w._id}','rejected')" title="رفض">❌</button>\`:''}
</div></td></tr>\`).join('')}

async function setStatus(id,status){
await fetch(A+'/orders/'+id+'/status',{method:'PUT',headers:H,body:JSON.stringify({status})});
loadOrders();loadStats()}

async function toggleUser(id){
await fetch(A+'/users/'+id+'/toggle',{method:'PUT',headers:H});
loadUsers()}

async function setWd(id,status){
if(!confirm('تأكيد؟'))return;
await fetch(A+'/withdrawals/'+id,{method:'PUT',headers:H,body:JSON.stringify({status})});
loadWd()}

function openProductModal(){pmId.value='';pmTitle.textContent='إضافة منتج جديد';pm.classList.add('on');document.getElementById('pmName').value='';document.getElementById('pmDesc').value='';document.getElementById('pmWhole').value='';document.getElementById('pmSug').value='';document.getElementById('pmStock').value='100'}

function editProduct(p){
pmId.value=p._id;pmTitle.textContent='تعديل منتج';
document.getElementById('pmName').value=p.name;
document.getElementById('pmDesc').value=p.description||'';
document.getElementById('pmCat').value=p.category||'general';
document.getElementById('pmWhole').value=p.wholesalePrice;
document.getElementById('pmSug').value=p.suggestedPrice;
document.getElementById('pmStock').value=p.stock;
pm.classList.add('on')}

async function saveProduct(e){
e.preventDefault();
const fd=new FormData();
fd.append('name',pmName.value);
fd.append('description',pmDesc.value);
fd.append('category',pmCat.value);
fd.append('wholesalePrice',pmWhole.value);
fd.append('suggestedPrice',pmSug.value);
fd.append('stock',pmStock.value);
if(document.getElementById('pmImage').files[0])fd.append('image',document.getElementById('pmImage').files[0]);
const id=pmId.value;
const url=id?A+'/products/'+id:A+'/products';
const method=id?'PUT':'POST';
const r=await fetch(url,{method,headers:H2,body:fd}).then(r=>r.json());
if(r.success){alert('✅ تم الحفظ');cm();loadProducts()}else alert('❌ '+r.error)}

async function delProduct(id){
if(!confirm('حذف المنتج؟'))return;
await fetch(A+'/products/'+id,{method:'DELETE',headers:H});
loadProducts()}

async function genDesc(){
if(!pmName.value)return alert('اكتب اسم المنتج أولاً');
const b=event.target;b.textContent='⏳ جاري التوليد...';b.disabled=true;
try{
const r=await fetch(A+'/products/generate-description',{method:'POST',headers:H,body:JSON.stringify({name:pmName.value,category:pmCat.value})}).then(r=>r.json());
if(r.success){document.getElementById('pmDesc').value=r.description}
else alert('AI غير متاح — اكتب الوصف يدوياً');
}catch(e){alert('خطأ: '+e.message)}
b.textContent='🤖 توليد وصف بالذكاء';b.disabled=false}

function out(){localStorage.clear();location.href='/'}

loadStats();
</script>
</body>
</html>`));

// ═══ Start server ═══
app.listen(PORT, () => {
  console.log('🚀 Server: http://localhost:' + PORT);
  setTimeout(seed, 2000);
});ent(145deg,#13171e,#0b0d10);border-radius:16px}.logo{font-weight:900;font-size:1.15rem}.btn{padding:10px 20px;background:transparent;border:1.5px solid rgba(255,255,255,.15);color:#fff;border-radius:40px;font-family:inherit;font-weight:700;cursor:pointer}.stats{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:20px}.stat{background:linear-gradient(145deg,#13171e,#0b0d10);border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:16px}.sv{font-size:1.4rem;font-weight:900;background:linear-gradient(135deg,#fff,#ffa733);-webkit-background-clip:text;-webkit-text-fill-color:transparent}.sl{font-size:.78rem;color:#6a7a8a;margin-top:4px}.card{background:linear-gradient(145deg,#13171e,#0b0d10);border:1px solid rgba(255,255,255,.06);border-radius:16px;padding:20px;margin-bottom:16px}.card h2{font-size:1.05rem;margin-bottom:14px}.prod{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}.p{background:rgba(26,84,144,.1);border:1px solid rgba(26,84,144,.25);border-radius:12px;padding:12px}.p h3{font-size:.85rem;margin-bottom:6px}.pp{color:#ffa733;font-weight:800;font-size:1rem}.pc{color:#4ade80;font-size:.72rem;font-weight:700;margin-bottom:8px}.p button{width:100%;padding:8px;background:linear-gradient(135deg,#1a5490,#ff8c00);color:#fff;border:none;border-radius:8px;font-family:inherit;font-weight:700;cursor:pointer;font-size:.85rem}.order{background:rgba(255,255,255,.03);border-radius:10px;padding:12px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center}.on{color:#7dd3fc;font-weight:700;font-size:.82rem}.oc{color:#a0b0c4;font-size:.75rem}.oa{color:#4ade80;font-weight:800;font-size:.9rem}.empty{text-align:center;padding:30px;color:#6a7a8a;font-size:.9rem}.modal{position:fixed;inset:0;background:rgba(0,0,0,.85);display:none;align-items:center;justify-content:center;padding:20px;z-index:999}.modal.active{display:flex}.mb{background:linear-gradient(145deg,#13171e,#0b0d10);border:1px solid rgba(255,140,0,.3);border-radius:18px;padding:24px;max-width:400px;width:100%;max-height:90vh;overflow-y:auto}.mb h2{margin-bottom:16px;font-size:1.15rem}.fg{margin-bottom:12px}.fg label{display:block;font-size:.8rem;color:#a0b0c4;margin-bottom:4px;font-weight:700}.fc{width:100%;padding:12px;background:rgba(255,255,255,.04);border:1.5px solid rgba(255,255,255,.08);border-radius:10px;color:#fff;font-family:inherit;outline:none;font-size:.95rem}.fc:focus{border-color:#ff8c00}</style></head><body><div class="container"><div class="header"><div class="logo">📦 Grossistes.Online</div><button class="btn" onclick="logout()">خروج</button></div><h2 style="margin-bottom:16px" id="welcome">مرحباً</h2><div class="stats" id="stats"></div><div class="card"><h2>📦 المنتجات</h2><div class="prod" id="prod">جاري التحميل...</div></div><div class="card"><h2>🛒 طلباتي</h2><div id="orders"><div class="empty">لا توجد طلبات</div></div></div></div><div class="modal" id="modal"><div class="mb"><h2>طلب جديد</h2><form onsubmit="createOrder(event)"><input type="hidden" id="pid"><input type="hidden" id="sprice"><div class="fg"><label>المنتج</label><input class="fc" id="pname" readonly></div><div class="fg"><label>اسم الزبون</label><input class="fc" id="cn" required></div><div class="fg"><label>الهاتف</label><input class="fc" id="cp" type="tel" required></div><div class="fg"><label>الولاية</label><input class="fc" id="cw" required></div><div class="fg"><label>العنوان</label><input class="fc" id="ca" required></div><div class="fg"><label>الكمية</label><input class="fc" id="qty" type="number" value="1" min="1"></div><button class="btn" style="width:100%;background:linear-gradient(135deg,#1a5490,#ff8c00);border:none;padding:14px">تأكيد</button><button type="button" class="btn" style="width:100%;margin-top:8px" onclick="closeModal()">إلغاء</button></form></div></div><script>const API=location.origin+"/api";const T=localStorage.getItem("t");if(!T)location.href="/";const H={"Content-Type":"application/json","Authorization":"Bearer "+T};async function load(){try{const[me,st,pr,or]=await Promise.all([fetch(API+"/me",{headers:H}).then(r=>r.json()),fetch(API+"/stats",{headers:H}).then(r=>r.json()),fetch(API+"/products").then(r=>r.json()),fetch(API+"/my-orders",{headers:H}).then(r=>r.json())]);if(me.user)welcome.textContent="مرحباً "+me.user.fullName;if(st.stats)stats.innerHTML=`<div class="stat"><div class="sv">${st.stats.balance.toLocaleString()} دج</div><div class="sl">الرصيد</div></div><div class="stat"><div class="sv">${st.stats.totalOrders}</div><div class="sl">الطلبات</div></div><div class="stat"><div class="sv">${st.stats.totalSales.toLocaleString()}</div><div class="sl">المبيعات</div></div><div class="stat"><div class="sv">${st.stats.totalCommission.toLocaleString()}</div><div class="sl">العمولات</div></div>`;if(pr.products)prod.innerHTML=pr.products.map(p=>`<div class="p"><h3>${p.name}</h3><div class="pp">${p.suggestedPrice} دج</div><div class="pc">+ ${p.suggestedPrice-p.wholesalePrice} دج</div><button onclick=\'om("${p._id}","${p.name.replace(/"/g,"")}",${p.suggestedPrice})\'>اطلب</button></div>`).join("");if(or.orders&&or.orders.length)orders.innerHTML=or.orders.map(o=>`<div class="order"><div><div class="on">${o.orderNumber}</div><div class="oc">${o.customer.fullName} — ${o.customer.wilaya}</div></div><div class="oa">+${o.totalCommission} دج</div></div>`).join("")}catch(e){console.error(e)}}function om(id,name,price){pid.value=id;pname.value=name;sprice.value=price;modal.classList.add("active")}function closeModal(){modal.classList.remove("active")}async function createOrder(e){e.preventDefault();try{const r=await fetch(API+"/orders",{method:"POST",headers:H,body:JSON.stringify({customer:{fullName:cn.value,phone:cp.value,wilaya:cw.value,address:ca.value},items:[{product:pid.value,quantity:+qty.value,sellingPrice:+sprice.value}]})});const d=await r.json();if(!d.success)throw new Error(d.message);alert("✅ تم إنشاء الطلب");closeModal();load()}catch(e){alert(e.message)}}function logout(){localStorage.removeItem("t");location.href="/"}load()</script></body></html>';

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
