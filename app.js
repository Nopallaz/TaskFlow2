/* TaskFlow - To-Do List App (Supabase edition: login, profil, data per pengguna) */

// Failsafe: jika ada error JS apapun, pastikan spinner loading selalu hilang
window.onerror = function () {
    const loader = document.getElementById('boot-loader');
    const authScreen = document.getElementById('auth-screen');
    if (loader) loader.hidden = true;
    if (authScreen) authScreen.hidden = false;
};

// =====================================================================
// KONFIGURASI SUPABASE
// Supabase Dashboard > Project Settings > API
// anon/public key AMAN ditaruh di frontend selama RLS aktif (lihat supabase-setup.sql).
// JANGAN PERNAH menaruh "service_role" key di sini.
// =====================================================================
const SUPABASE_URL = 'https://stprifbkuiozycxxkdfs.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN0cHJpZmJrdWlvenljeHhrZGZzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE4Nzc0NzksImV4cCI6MjEwNzQ1MzQ3OX0.YvSH0yfCXLu10gartgvbUUXzt7XjkrmVix5qCyM06qk';

const APP_URL = window.location.origin + window.location.pathname;
const isConfigured = !SUPABASE_URL.includes('YOUR-PROJECT-ID') && !SUPABASE_ANON_KEY.includes('YOUR-ANON') && typeof window.supabase !== 'undefined';
let sb = null;
try {
    sb = isConfigured ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
} catch (e) {
    console.error('Gagal inisialisasi Supabase client:', e);
    const loader = document.getElementById('boot-loader');
    const authScreen = document.getElementById('auth-screen');
    if (loader) loader.hidden = true;
    if (authScreen) authScreen.hidden = false;
}

// App State
let tasks = [];
let categories = [];
let currentFilter = 'all';
let searchQuery = '';
let isDarkMode = localStorage.getItem('theme') === 'dark';

// Auth State
let currentUser = null;
let profile = null;
let authMode = 'login'; // 'login' | 'register' | 'forgot'

// Form tugas & pengingat
let currentTags = [];
let reminderTimer = null;
const REMINDER_LABELS = { 5: '5 mnt', 15: '15 mnt', 30: '30 mnt', 60: '1 jam', 1440: '1 hari' };
const REPEAT_LABELS = { daily: 'Harian', weekly: 'Mingguan', monthly: 'Bulanan' };

// Selectors
const $ = (id) => document.getElementById(id);
const tasksContainer = $('tasks-container');
const emptyState = $('empty-state');
const taskForm = $('task-form');
const taskModal = $('task-modal');
const categoryModal = $('category-modal');
const addTaskBtn = $('add-task-btn');
const clearCompletedBtn = $('clear-completed-btn');
const modalClose = $('modal-close');
const cancelBtn = $('cancel-btn');
const themeToggle = $('theme-toggle');
const searchInput = $('search-input');
const navItems = document.querySelectorAll('.nav-item');
const categoryList = $('category-list');
const currentDateEl = $('current-date');
const pageTitle = $('page-title');
const pageSubtitle = $('page-subtitle');
const taskCategorySelect = $('task-category');
const toastContainer = $('toast-container');
const menuToggle = $('menu-toggle');
const sidebar = document.querySelector('.sidebar');

// =====================================================================
// HELPER
// =====================================================================
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
}

// Tanggal lokal (YYYY-MM-DD). toISOString() memakai UTC sehingga di WIB
// "hari ini" bisa salah pada pukul 00.00-07.00.
function toDateStr(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function todayStr() {
    return toDateStr(new Date());
}

// Tambah 1 hari / 1 minggu / 1 bulan pada tanggal 'YYYY-MM-DD'
function addInterval(dateStr, interval) {
    const [y, m, d] = dateStr.split('-').map(Number);
    if (interval === 'monthly') {
        const lastDay = new Date(y, m + 1, 0).getDate(); // hari terakhir bulan berikutnya
        return toDateStr(new Date(y, m, Math.min(d, lastDay)));
    }
    return toDateStr(new Date(y, m - 1, d + (interval === 'weekly' ? 7 : 1)));
}

function errMsg(err) {
    const m = (err && err.message) || 'Terjadi kesalahan.';
    const map = [
        ['Invalid login credentials', 'Email atau password salah.'],
        ['Email not confirmed', 'Email belum dikonfirmasi. Cek kotak masuk Anda.'],
        ['User already registered', 'Email sudah terdaftar. Silakan masuk.'],
        ['Password should be at least', 'Password terlalu pendek.'],
        ['rate limit', 'Terlalu banyak percobaan. Coba lagi beberapa saat lagi.'],
        ['Failed to fetch', 'Tidak dapat terhubung ke server. Periksa koneksi internet.'],
        ['different from the old password', 'Password baru harus berbeda dari password lama.'],
        ['reauthentication', 'Demi keamanan, keluar lalu masuk lagi sebelum mengubah ini.'],
        ['Unable to validate email', 'Format email tidak valid.']
    ];
    const hit = map.find(([key]) => m.toLowerCase().includes(key.toLowerCase()));
    return hit ? hit[1] : m;
}

function setBusy(btn, busy) {
    btn.disabled = busy;
}

// Konversi baris database <-> objek aplikasi
function fromTaskRow(r) {
    return {
        id: r.id,
        title: r.title,
        description: r.description || '',
        date: r.due_date,
        time: r.due_time ? r.due_time.slice(0, 5) : '',
        priority: r.priority,
        categoryId: r.category_id,
        completed: r.completed,
        tags: r.tags || [],
        reminder: r.reminder_minutes || null,
        repeat: r.repeat_interval || null,
        createdAt: r.created_at
    };
}

function toTaskRow(t) {
    return {
        title: t.title,
        description: t.description,
        due_date: t.date,
        due_time: t.time || null,
        priority: t.priority,
        category_id: t.categoryId || null,
        completed: t.completed,
        tags: t.tags || [],
        reminder_minutes: t.reminder || null,
        repeat_interval: t.repeat || null
    };
}

const fromCategoryRow = (r) => ({ id: r.id, name: r.name, color: r.color });

// =====================================================================
// RENDER
// =====================================================================
function renderTasks() {
    const today = todayStr();
    let filteredTasks = tasks.filter(task => {
        const q = searchQuery.toLowerCase();
        const matchesSearch = task.title.toLowerCase().includes(q) ||
            task.description.toLowerCase().includes(q) ||
            task.tags.some(t => t.toLowerCase().includes(q));

        if (!matchesSearch) return false;

        if (currentFilter === 'all') return true;
        if (currentFilter === 'completed') return task.completed;
        if (currentFilter === 'today') return task.date === today && !task.completed;
        if (currentFilter === 'upcoming') return task.date > today && !task.completed;
        if (currentFilter === 'overdue') return task.date < today && !task.completed;

        // Category filter
        return task.categoryId === currentFilter;
    });

    // Sort: Uncompleted first, then by date, then by priority
    filteredTasks.sort((a, b) => {
        if (a.completed !== b.completed) return a.completed ? 1 : -1;
        if (a.date !== b.date) return a.date > b.date ? 1 : -1;
        const priorityMap = { high: 0, medium: 1, low: 2 };
        return priorityMap[a.priority] - priorityMap[b.priority];
    });

    tasksContainer.innerHTML = '';

    if (filteredTasks.length === 0) {
        emptyState.style.display = 'flex';
        tasksContainer.style.display = 'none';
    } else {
        emptyState.style.display = 'none';
        tasksContainer.style.display = 'grid';

        filteredTasks.forEach(task => {
            const category = categories.find(c => c.id === task.categoryId) ||
                categories[0] || { name: 'Tanpa Kategori', color: '#636e72' };
            const taskEl = document.createElement('div');
            taskEl.className = `task-card priority-${task.priority} ${task.completed ? 'completed' : ''}`;
            taskEl.innerHTML = `
                <div class="task-header">
                    <div>
                        <h3 class="task-title">${escapeHtml(task.title)}</h3>
                        <p class="task-description">${escapeHtml(task.description) || 'Tidak ada deskripsi'}</p>
                        <div class="task-meta">
                            <span class="task-category" style="background: ${escapeHtml(category.color)}20; color: ${escapeHtml(category.color)}">${escapeHtml(category.name)}</span>
                            <span class="task-date">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                                ${formatDate(task.date)} ${task.time ? '| ' + escapeHtml(task.time) : ''}
                            </span>
                            <span class="priority-badge">${escapeHtml(task.priority.toUpperCase())}</span>
                            ${task.reminder ? `<span class="task-flag" title="Pengingat">🔔 ${REMINDER_LABELS[task.reminder] || ''}</span>` : ''}
                            ${task.repeat ? `<span class="task-flag" title="Tugas berulang">🔁 ${REPEAT_LABELS[task.repeat] || ''}</span>` : ''}
                        </div>
                        ${task.tags.length ? `<div class="task-tags">${task.tags.map(t => `<span class="tag-chip">#${escapeHtml(t)}</span>`).join('')}</div>` : ''}
                    </div>
                    <div class="task-checkbox" onclick="toggleTaskStatus('${task.id}')">
                        <svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                    </div>
                </div>
                <div class="task-actions">
                    <button class="action-btn" onclick="editTask('${task.id}')" title="Edit">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                    <button class="action-btn delete" onclick="deleteTask('${task.id}')" title="Hapus">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
                    </button>
                </div>
            `;
            tasksContainer.appendChild(taskEl);
        });
    }
    updateStats();
}

function renderCategories() {
    categoryList.innerHTML = '';
    taskCategorySelect.innerHTML = '';

    categories.forEach(cat => {
        // Sidebar list
        const catEl = document.createElement('div');
        catEl.className = `category-item ${currentFilter === cat.id ? 'active' : ''}`;
        catEl.innerHTML = `
            <div class="category-color" style="background: ${escapeHtml(cat.color)}"></div>
            <span class="category-name">${escapeHtml(cat.name)}</span>
        `;
        catEl.onclick = () => filterByCategory(cat.id, cat.name);
        categoryList.appendChild(catEl);

        // Form select
        const option = document.createElement('option');
        option.value = cat.id;
        option.textContent = cat.name;
        taskCategorySelect.appendChild(option);
    });
}

// =====================================================================
// DATA (SUPABASE)
// =====================================================================
async function loadUserData() {
    const [cats, tks] = await Promise.all([
        sb.from('categories').select('*').order('created_at', { ascending: true }),
        sb.from('tasks').select('*').order('created_at', { ascending: true })
    ]);
    if (cats.error) throw cats.error;
    if (tks.error) throw tks.error;
    categories = cats.data.map(fromCategoryRow);
    tasks = tks.data.map(fromTaskRow);
}

// Task Actions
async function saveTask(e) {
    e.preventDefault();
    const id = $('task-id').value;
    const existing = id ? tasks.find(t => t.id === id) : null;
    flushPendingTag();
    const reminderVal = $('task-reminder').value;
    const row = toTaskRow({
        title: $('task-title').value.trim(),
        description: $('task-description').value.trim(),
        date: $('task-date').value,
        time: $('task-time').value,
        priority: $('task-priority').value,
        categoryId: $('task-category').value,
        completed: existing ? existing.completed : false,
        tags: currentTags.slice(),
        reminder: reminderVal === 'none' ? null : parseInt(reminderVal, 10),
        repeat: $('task-repeat').checked ? $('repeat-interval').value : null
    });

    if (!row.title) {
        showToast('Judul tugas tidak boleh kosong.', 'warning');
        return;
    }

    const btn = $('submit-btn');
    setBusy(btn, true);
    try {
        if (id) {
            const { data, error } = await sb.from('tasks').update(row).eq('id', id).select().single();
            if (error) throw error;
            tasks = tasks.map(t => t.id === id ? fromTaskRow(data) : t);
            showToast('Tugas berhasil diperbarui!', 'success');
        } else {
            const { data, error } = await sb.from('tasks').insert(row).select().single();
            if (error) throw error;
            tasks.push(fromTaskRow(data));
            showToast('Tugas baru ditambahkan!', 'success');
        }
        renderTasks();
        closeModal();
        if (row.reminder_minutes) { ensureNotificationPermission(); checkReminders(); }
    } catch (err) {
        showToast('Gagal menyimpan tugas: ' + errMsg(err), 'error');
    } finally {
        setBusy(btn, false);
    }
}

async function clearCompletedTasks() {
    const completedCount = tasks.filter(task => task.completed).length;

    if (completedCount === 0) {
        showToast('Tidak ada tugas yang sudah selesai.', 'warning');
        return;
    }

    if (!confirm(`Hapus ${completedCount} tugas yang sudah selesai?`)) return;

    const { error } = await sb.from('tasks').delete().eq('completed', true);
    if (error) {
        showToast('Gagal menghapus tugas: ' + errMsg(error), 'error');
        return;
    }
    tasks = tasks.filter(task => !task.completed);
    showToast(`${completedCount} tugas berhasil dihapus.`, 'success');
    renderTasks();
}

async function deleteTask(id) {
    if (!confirm('Hapus tugas ini?')) return;

    const { error } = await sb.from('tasks').delete().eq('id', id);
    if (error) {
        showToast('Gagal menghapus tugas: ' + errMsg(error), 'error');
        return;
    }
    tasks = tasks.filter(t => t.id !== id);
    showToast('Tugas dihapus', 'warning');
    renderTasks();
}

async function toggleTaskStatus(id) {
    const task = tasks.find(t => t.id === id);
    if (!task) return;

    const newState = !task.completed;
    // Perbarui tampilan dulu (optimistic), batalkan jika gagal
    task.completed = newState;
    renderTasks();

    const { error } = await sb.from('tasks').update({ completed: newState }).eq('id', id);
    if (error) {
        task.completed = !newState;
        renderTasks();
        showToast('Gagal memperbarui tugas: ' + errMsg(error), 'error');
        return;
    }
    if (newState) {
        showToast('Tugas selesai! 🎉', 'success');
        if (task.repeat) await spawnNextRepeat(task);
    }
}

// Tugas berulang: saat diselesaikan, buat tugas berikutnya (tidak pernah di masa lalu)
async function spawnNextRepeat(task) {
    const today = todayStr();
    let nextDate = addInterval(task.date, task.repeat);
    for (let i = 0; nextDate < today && i < 400; i++) nextDate = addInterval(nextDate, task.repeat);

    const duplicate = tasks.some(t => !t.completed && t.id !== task.id &&
        t.title === task.title && t.repeat === task.repeat && t.date === nextDate);
    if (duplicate) return;

    const { data, error } = await sb.from('tasks')
        .insert(toTaskRow({ ...task, date: nextDate, completed: false })).select().single();
    if (error) {
        showToast('Gagal membuat tugas berulang: ' + errMsg(error), 'error');
        return;
    }
    tasks.push(fromTaskRow(data));
    renderTasks();
    showToast(`Tugas berulang dibuat untuk ${formatDate(nextDate)}.`, 'success');
}

function editTask(id) {
    const task = tasks.find(t => t.id === id);
    if (!task) return;

    $('modal-title').textContent = 'Edit Tugas';
    $('task-id').value = task.id;
    $('task-title').value = task.title;
    $('task-description').value = task.description;
    $('task-date').value = task.date;
    $('task-time').value = task.time;
    $('task-priority').value = task.priority;
    if (task.categoryId) $('task-category').value = task.categoryId;
    currentTags = task.tags.slice();
    renderTagChips();
    $('task-reminder').value = task.reminder ? String(task.reminder) : 'none';
    $('task-repeat').checked = !!task.repeat;
    $('repeat-interval').disabled = !task.repeat;
    if (task.repeat) $('repeat-interval').value = task.repeat;

    openModal();
}

async function addCategory(e) {
    e.preventDefault();
    const name = $('category-name').value.trim();
    const color = document.querySelector('input[name="category-color"]:checked').value;
    if (!name) return;

    const { data, error } = await sb.from('categories').insert({ name, color }).select().single();
    if (error) {
        showToast('Gagal menambah kategori: ' + errMsg(error), 'error');
        return;
    }
    categories.push(fromCategoryRow(data));
    renderCategories();
    categoryModal.classList.remove('active');
    $('category-form').reset();
    showToast('Kategori baru ditambahkan!', 'success');
}

// Impor data lama yang tersimpan di localStorage (sebelum ada login)
async function offerLocalImport() {
    const flag = 'taskflow_import_' + currentUser.id;
    if (localStorage.getItem(flag)) return;

    let localTasks = [];
    let localCats = [];
    try {
        localTasks = JSON.parse(localStorage.getItem('tasks') || '[]');
        localCats = JSON.parse(localStorage.getItem('categories') || '[]');
    } catch (_) { return; }
    if (!Array.isArray(localTasks) || localTasks.length === 0) return;

    if (!confirm(`Ditemukan ${localTasks.length} tugas yang tersimpan di browser ini. Impor ke akun Anda?`)) {
        localStorage.setItem(flag, 'skipped');
        return;
    }

    try {
        const idMap = {};
        for (const lc of (Array.isArray(localCats) ? localCats : [])) {
            const name = String(lc.name || '').trim().slice(0, 40);
            if (!name) continue;
            const existing = categories.find(c => c.name.toLowerCase() === name.toLowerCase());
            if (existing) { idMap[lc.id] = existing.id; continue; }
            const color = /^#[0-9a-fA-F]{6}$/.test(lc.color) ? lc.color : '#667eea';
            const { data, error } = await sb.from('categories').insert({ name, color }).select().single();
            if (error) throw error;
            categories.push(fromCategoryRow(data));
            idMap[lc.id] = data.id;
        }

        const rows = localTasks.map(t => ({
            title: String(t.title || 'Tanpa judul').slice(0, 200),
            description: String(t.description || '').slice(0, 2000),
            due_date: t.date || todayStr(),
            due_time: t.time || null,
            priority: ['low', 'medium', 'high'].includes(t.priority) ? t.priority : 'medium',
            category_id: idMap[t.categoryId] || null,
            completed: !!t.completed
        }));
        const { data, error } = await sb.from('tasks').insert(rows).select();
        if (error) throw error;

        tasks.push(...data.map(fromTaskRow));
        localStorage.setItem(flag, 'done');
        localStorage.removeItem('tasks');
        localStorage.removeItem('categories');
        renderCategories();
        renderTasks();
        showToast(`${data.length} tugas berhasil diimpor.`, 'success');
    } catch (err) {
        showToast('Gagal mengimpor data: ' + errMsg(err), 'error');
    }
}

// =====================================================================
// AUTH
// =====================================================================
function showAuthScreen() {
    document.body.classList.remove('logged-in');
    $('boot-loader').hidden = true;
    $('auth-screen').hidden = false;
}

function setAuthMessage(text, type = 'error') {
    const el = $('auth-message');
    el.hidden = !text;
    el.textContent = text || '';
    el.className = 'auth-message ' + type;
}

function setAuthMode(mode) {
    authMode = mode;
    const isLogin = mode === 'login';
    const isReg = mode === 'register';
    const isForgot = mode === 'forgot';

    $('auth-name-group').hidden = !isReg;
    $('auth-password-group').hidden = isForgot;
    $('auth-password').required = !isForgot;
    $('auth-password').autocomplete = isReg ? 'new-password' : 'current-password';
    $('auth-tabs').hidden = isForgot;
    $('auth-oauth').hidden = isForgot;
    $('auth-forgot').hidden = !isLogin;
    $('auth-back').hidden = !isForgot;
    $('auth-submit').textContent = isLogin ? 'Masuk' : isReg ? 'Buat Akun' : 'Kirim Link Reset';
    $('auth-subtitle').textContent = isLogin
        ? 'Masuk untuk melihat tugas Anda'
        : isReg ? 'Buat akun baru untuk mulai mengatur tugas'
            : 'Masukkan email untuk menerima link reset password';
    document.querySelectorAll('.auth-tab').forEach(tab =>
        tab.classList.toggle('active', tab.dataset.mode === mode));
    setAuthMessage('');
}

async function handleAuthSubmit(e) {
    e.preventDefault();
    const email = $('auth-email').value.trim();
    const password = $('auth-password').value;
    const btn = $('auth-submit');

    setAuthMessage('');
    setBusy(btn, true);
    try {
        if (authMode === 'login') {
            const { error } = await sb.auth.signInWithPassword({ email, password });
            if (error) throw error;
            // Perpindahan layar ditangani oleh onAuthStateChange
        } else if (authMode === 'register') {
            const name = $('auth-name').value.trim();
            if (!name) throw new Error('Nama lengkap wajib diisi.');
            if (password.length < 8) throw new Error('Password minimal 8 karakter.');
            const { data, error } = await sb.auth.signUp({
                email,
                password,
                options: { data: { full_name: name }, emailRedirectTo: APP_URL }
            });
            if (error) throw error;
            if (!data.session) {
                // Konfirmasi email aktif di Supabase
                setAuthMode('login');
                setAuthMessage('Akun dibuat. Cek email Anda untuk konfirmasi, lalu masuk.', 'success');
            }
        } else {
            const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: APP_URL });
            if (error) throw error;
            setAuthMode('login');
            setAuthMessage('Jika email terdaftar, link reset password sudah dikirim.', 'success');
        }
    } catch (err) {
        setAuthMessage(errMsg(err));
    } finally {
        setBusy(btn, false);
    }
}

async function handleGoogleLogin() {
    setAuthMessage('');
    const { error } = await sb.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: APP_URL }
    });
    if (error) setAuthMessage(errMsg(error));
}

async function onLogin(user) {
    currentUser = user;
    try {
        await Promise.all([loadProfile(), loadUserData()]);
    } catch (err) {
        showToast('Gagal memuat data: ' + errMsg(err), 'error');
    }

    $('boot-loader').hidden = true;
    $('auth-screen').hidden = true;
    document.body.classList.add('logged-in');

    renderProfile();
    renderCategories();
    renderTasks();
    $('task-date').value = todayStr();
    startReminders();
    offerLocalImport();
}

function onLogout() {
    stopReminders();
    currentUser = null;
    profile = null;
    tasks = [];
    categories = [];
    currentFilter = 'all';
    searchQuery = '';
    searchInput.value = '';
    pageTitle.textContent = 'Semua Tugas';
    pageSubtitle.textContent = 'Kelola semua tugas Anda di satu tempat';
    navItems.forEach(i => i.classList.toggle('active', i.dataset.filter === 'all'));
    document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('active'));
    $('auth-form').reset();
    setAuthMode('login');
    showAuthScreen();
}

async function logout() {
    const { error } = await sb.auth.signOut();
    if (error) {
        // Sesi lokal tetap dibersihkan
        await sb.auth.signOut({ scope: 'local' });
    }
}

function initAuth() {
    if (!isConfigured) {
        showAuthScreen();
        $('auth-form').querySelectorAll('input, button').forEach(el => el.disabled = true);
        $('google-login-btn').disabled = true;
        setAuthMessage('Isi SUPABASE_URL dan SUPABASE_ANON_KEY di bagian atas app.js terlebih dahulu.', 'info');
        return;
    }

    // Fallback: jika onAuthStateChange tidak terpanggil dalam 8 detik
    // (misal koneksi lambat / Supabase timeout), paksa tampilkan auth screen
    let authResolved = false;
    const authFallbackTimer = setTimeout(() => {
        if (!authResolved) {
            console.warn('Auth state timeout — menampilkan layar login.');
            showAuthScreen();
            setAuthMessage('Koneksi ke server lambat. Silakan coba lagi.', 'info');
        }
    }, 8000);

    // INITIAL_SESSION dipicu otomatis saat subscribe (sesi tersimpan atau null).
    // Jangan memanggil method Supabase langsung di dalam callback -> bungkus setTimeout.
    sb.auth.onAuthStateChange((event, session) => {
        setTimeout(() => {
            authResolved = true;
            clearTimeout(authFallbackTimer);
            if (session && session.user) {
                if (currentUser && currentUser.id === session.user.id) {
                    currentUser = session.user; // refresh token / update user
                    renderProfile();
                } else {
                    onLogin(session.user);
                }
                if (event === 'PASSWORD_RECOVERY') $('reset-modal').classList.add('active');
            } else if (currentUser) {
                onLogout();
            } else {
                showAuthScreen();
            }
        }, 0);
    });
}

// =====================================================================
// PROFIL
// =====================================================================
async function loadProfile() {
    const { data, error } = await sb.from('profiles').select('*').eq('id', currentUser.id).maybeSingle();
    if (error) throw error;
    if (data) {
        profile = data;
        return;
    }
    // Cadangan bila trigger database belum membuat profil
    const fallbackName = (currentUser.user_metadata && currentUser.user_metadata.full_name) ||
        (currentUser.email || '').split('@')[0];
    const ins = await sb.from('profiles').insert({ id: currentUser.id, full_name: fallbackName }).select().single();
    if (ins.error) throw ins.error;
    profile = ins.data;
}

function displayName() {
    return (profile && profile.full_name) ||
        (currentUser && currentUser.email ? currentUser.email.split('@')[0] : 'Pengguna');
}

function initialsOf(name) {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    const first = parts[0][0];
    const second = parts.length > 1 ? parts[parts.length - 1][0] : '';
    return (first + second).toUpperCase();
}

function setAvatar(el, name, url) {
    if (url) {
        el.style.backgroundImage = `url("${url.replace(/"/g, '%22')}")`;
        el.classList.add('has-image');
        el.textContent = '';
    } else {
        el.style.backgroundImage = '';
        el.classList.remove('has-image');
        el.textContent = initialsOf(name);
    }
}

function renderProfile() {
    if (!currentUser) return;
    const name = displayName();
    $('user-name').textContent = name;
    $('user-status').textContent = currentUser.email || '';
    setAvatar($('user-avatar'), name, profile && profile.avatar_url);
    setAvatar($('profile-avatar-preview'), name, profile && profile.avatar_url);
    $('avatar-remove-btn').hidden = !(profile && profile.avatar_url);
}

function openProfileModal() {
    $('profile-name').value = profile ? profile.full_name : '';
    $('profile-bio').value = profile ? profile.bio : '';
    $('profile-email').value = currentUser.email || '';
    $('email-form').reset();
    $('password-form').reset();
    $('profile-email').value = currentUser.email || '';
    renderProfile();
    $('profile-modal').classList.add('active');
}

function closeProfileModal() {
    $('profile-modal').classList.remove('active');
}

async function saveProfile(e) {
    e.preventDefault();
    const full_name = $('profile-name').value.trim();
    const bio = $('profile-bio').value.trim();
    if (!full_name) {
        showToast('Nama tidak boleh kosong.', 'warning');
        return;
    }
    const btn = $('profile-save-btn');
    setBusy(btn, true);
    const { data, error } = await sb.from('profiles')
        .update({ full_name, bio, updated_at: new Date().toISOString() })
        .eq('id', currentUser.id).select().single();
    setBusy(btn, false);
    if (error) {
        showToast('Gagal menyimpan profil: ' + errMsg(error), 'error');
        return;
    }
    profile = data;
    renderProfile();
    showToast('Profil berhasil diperbarui!', 'success');
}

const AVATAR_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

function avatarPathFromUrl(url) {
    if (!url) return null;
    const marker = '/avatars/';
    const i = url.indexOf(marker);
    return i < 0 ? null : decodeURIComponent(url.slice(i + marker.length).split('?')[0]);
}

async function removeAvatarFile(url) {
    const path = avatarPathFromUrl(url);
    if (path && path.startsWith(currentUser.id + '/')) {
        await sb.storage.from('avatars').remove([path]);
    }
}

async function handleAvatarSelected(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;

    const ext = AVATAR_TYPES[file.type];
    if (!ext) {
        showToast('Format foto harus JPG, PNG, atau WebP.', 'warning');
        return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
        showToast('Ukuran foto maksimal 2 MB.', 'warning');
        return;
    }

    const btn = $('avatar-change-btn');
    setBusy(btn, true);
    const path = `${currentUser.id}/avatar-${Date.now()}.${ext}`;
    try {
        const up = await sb.storage.from('avatars').upload(path, file, { contentType: file.type, cacheControl: '3600' });
        if (up.error) throw up.error;

        const { data: urlData } = sb.storage.from('avatars').getPublicUrl(path);
        const { data, error } = await sb.from('profiles')
            .update({ avatar_url: urlData.publicUrl, updated_at: new Date().toISOString() })
            .eq('id', currentUser.id).select().single();
        if (error) {
            await sb.storage.from('avatars').remove([path]);
            throw error;
        }

        const oldUrl = profile && profile.avatar_url;
        profile = data;
        if (oldUrl) removeAvatarFile(oldUrl);
        renderProfile();
        showToast('Foto profil diperbarui!', 'success');
    } catch (err) {
        showToast('Gagal mengunggah foto: ' + errMsg(err), 'error');
    } finally {
        setBusy(btn, false);
    }
}

async function removeAvatar() {
    if (!profile || !profile.avatar_url) return;
    if (!confirm('Hapus foto profil?')) return;

    const oldUrl = profile.avatar_url;
    const { data, error } = await sb.from('profiles')
        .update({ avatar_url: null, updated_at: new Date().toISOString() })
        .eq('id', currentUser.id).select().single();
    if (error) {
        showToast('Gagal menghapus foto: ' + errMsg(error), 'error');
        return;
    }
    profile = data;
    removeAvatarFile(oldUrl);
    renderProfile();
    showToast('Foto profil dihapus.', 'warning');
}

async function changeEmail(e) {
    e.preventDefault();
    const newEmail = $('new-email').value.trim();
    if (newEmail.toLowerCase() === (currentUser.email || '').toLowerCase()) {
        showToast('Email baru sama dengan email saat ini.', 'warning');
        return;
    }
    const btn = $('email-save-btn');
    setBusy(btn, true);
    const { error } = await sb.auth.updateUser({ email: newEmail }, { emailRedirectTo: APP_URL });
    setBusy(btn, false);
    if (error) {
        showToast('Gagal mengubah email: ' + errMsg(error), 'error');
        return;
    }
    $('email-form').reset();
    showToast('Link konfirmasi dikirim. Email berubah setelah Anda mengonfirmasinya.', 'success');
}

async function changePassword(e) {
    e.preventDefault();
    const pw = $('new-password').value;
    if (pw.length < 8) {
        showToast('Password minimal 8 karakter.', 'warning');
        return;
    }
    if (pw !== $('confirm-password').value) {
        showToast('Konfirmasi password tidak sama.', 'warning');
        return;
    }
    const btn = $('password-save-btn');
    setBusy(btn, true);
    const { error } = await sb.auth.updateUser({ password: pw });
    setBusy(btn, false);
    if (error) {
        showToast('Gagal mengubah password: ' + errMsg(error), 'error');
        return;
    }
    $('password-form').reset();
    showToast('Password berhasil diubah!', 'success');
}

async function handleResetPassword(e) {
    e.preventDefault();
    const pw = $('reset-password').value;
    if (pw.length < 8) {
        showToast('Password minimal 8 karakter.', 'warning');
        return;
    }
    if (pw !== $('reset-confirm').value) {
        showToast('Konfirmasi password tidak sama.', 'warning');
        return;
    }
    const btn = $('reset-save-btn');
    setBusy(btn, true);
    const { error } = await sb.auth.updateUser({ password: pw });
    setBusy(btn, false);
    if (error) {
        showToast('Gagal menyimpan password: ' + errMsg(error), 'error');
        return;
    }
    $('reset-form').reset();
    $('reset-modal').classList.remove('active');
    history.replaceState(null, '', APP_URL); // bersihkan token dari URL
    showToast('Password berhasil diperbarui!', 'success');
}

async function deleteAccount() {
    const answer = prompt('Akun dan SEMUA data Anda akan dihapus permanen.\nKetik HAPUS untuk melanjutkan:');
    if (answer !== 'HAPUS') return;

    const btn = $('delete-account-btn');
    setBusy(btn, true);
    try {
        // Hapus file foto lebih dulu lewat API storage
        const { data: files } = await sb.storage.from('avatars').list(currentUser.id);
        if (files && files.length) {
            await sb.storage.from('avatars').remove(files.map(f => `${currentUser.id}/${f.name}`));
        }
        const { error } = await sb.rpc('delete_my_account');
        if (error) throw error;
        await sb.auth.signOut({ scope: 'local' });
        onLogout();
        showToast('Akun Anda telah dihapus.', 'warning');
    } catch (err) {
        showToast('Gagal menghapus akun: ' + errMsg(err), 'error');
    } finally {
        setBusy(btn, false);
    }
}

// =====================================================================
// TAG
// =====================================================================
function addTag(raw) {
    const tag = raw.trim().replace(/^#+/, '').slice(0, 20);
    if (!tag) return;
    if (currentTags.some(t => t.toLowerCase() === tag.toLowerCase())) return;
    if (currentTags.length >= 10) {
        showToast('Maksimal 10 tag per tugas.', 'warning');
        return;
    }
    currentTags.push(tag);
    renderTagChips();
}

function flushPendingTag() {
    const input = $('tag-input');
    if (input.value.trim()) addTag(input.value);
    input.value = '';
}

function renderTagChips() {
    const list = $('tags-list');
    list.innerHTML = '';
    currentTags.forEach((tag, i) => {
        const el = document.createElement('span');
        el.className = 'tag-item';
        el.appendChild(document.createTextNode('#' + tag));
        const x = document.createElement('span');
        x.className = 'remove-tag';
        x.textContent = '×';
        x.title = 'Hapus tag';
        x.onclick = () => { currentTags.splice(i, 1); renderTagChips(); };
        el.appendChild(x);
        list.appendChild(el);
    });
}

// =====================================================================
// PENGINGAT (aktif selama TaskFlow terbuka di browser)
// =====================================================================
function ensureNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
}

function firedStorageKey() { return 'taskflow_fired_' + currentUser.id; }

function readFired() {
    try { return JSON.parse(localStorage.getItem(firedStorageKey()) || '{}'); }
    catch (_) { return {}; }
}

function checkReminders() {
    if (!currentUser) return;
    const now = Date.now();
    const fired = readFired();
    let changed = false;

    tasks.forEach(t => {
        if (t.completed || !t.reminder) return;
        const [y, m, d] = t.date.split('-').map(Number);
        // Tanpa jam, tugas dianggap jatuh tempo pukul 09.00
        const [hh, mm] = (t.time || '09:00').split(':').map(Number);
        const due = new Date(y, m - 1, d, hh, mm).getTime();
        const remindAt = due - t.reminder * 60000;
        const key = `${t.id}|${t.date}|${t.time}|${t.reminder}`;

        if (now >= remindAt && now < due && !fired[key]) {
            fired[key] = now;
            changed = true;
            notifyReminder(t);
        }
    });

    // Bersihkan catatan yang sudah lebih dari 7 hari
    Object.keys(fired).forEach(k => {
        if (now - fired[k] > 7 * 86400000) { delete fired[k]; changed = true; }
    });
    if (changed) localStorage.setItem(firedStorageKey(), JSON.stringify(fired));
}

function notifyReminder(task) {
    const when = `${formatDate(task.date)}${task.time ? ' ' + task.time : ''}`;
    showToast(`🔔 Pengingat: ${task.title} (${when})`, 'warning', 8000);
    if ('Notification' in window && Notification.permission === 'granted') {
        try { new Notification('TaskFlow: ' + task.title, { body: 'Jatuh tempo ' + when }); } catch (_) { }
    }
}

function startReminders() {
    stopReminders();
    checkReminders();
    reminderTimer = setInterval(checkReminders, 30000);
}

function stopReminders() {
    if (reminderTimer) clearInterval(reminderTimer);
    reminderTimer = null;
}

// =====================================================================
// UI HELPERS
// =====================================================================
function openModal() {
    taskModal.classList.add('active');
}

function closeModal() {
    taskModal.classList.remove('active');
    taskForm.reset();
    $('task-id').value = '';
    $('modal-title').textContent = 'Tambah Tugas Baru';
    $('task-date').value = todayStr();
    currentTags = [];
    renderTagChips();
    $('tag-input').value = '';
    $('repeat-interval').disabled = true;
}

function updateStats() {
    const total = tasks.length;
    const completed = tasks.filter(t => t.completed).length;
    const progress = total === 0 ? 0 : Math.round((completed / total) * 100);

    $('stat-total').textContent = total;
    $('stat-completed').textContent = completed;
    $('stat-progress').textContent = `${progress}%`;
    $('progress-fill').style.width = `${progress}%`;
    $('progress-text').textContent = `${completed} dari ${total} tugas selesai`;

    // Badges
    const today = todayStr();
    $('badge-all').textContent = total;
    $('badge-today').textContent = tasks.filter(t => t.date === today && !t.completed).length;
    $('badge-upcoming').textContent = tasks.filter(t => t.date > today && !t.completed).length;
    $('badge-completed').textContent = completed;
    $('badge-overdue').textContent = tasks.filter(t => t.date < today && !t.completed).length;
}

function filterByCategory(id, name) {
    currentFilter = id;
    pageTitle.textContent = name;
    pageSubtitle.textContent = `Tugas dalam kategori ${name}`;
    navItems.forEach(item => item.classList.remove('active'));
    renderTasks();
    renderCategories();
}

function applyTheme() {
    if (isDarkMode) {
        document.body.classList.add('dark-mode');
        document.querySelector('.sun-icon').style.display = 'none';
        document.querySelector('.moon-icon').style.display = 'block';
    } else {
        document.body.classList.remove('dark-mode');
        document.querySelector('.sun-icon').style.display = 'block';
        document.querySelector('.moon-icon').style.display = 'none';
    }
}

function showToast(message, type = 'success', duration = 3500) {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const span = document.createElement('span');
    span.textContent = message;
    toast.appendChild(span);
    toastContainer.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

function formatDate(dateStr) {
    const options = { day: 'numeric', month: 'short' };
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('id-ID', options);
}

function updateDate() {
    const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    currentDateEl.textContent = new Date().toLocaleDateString('id-ID', options);
}

// =====================================================================
// EVENT LISTENERS
// =====================================================================
function setupEventListeners() {
    addTaskBtn.onclick = openModal;
    clearCompletedBtn.onclick = clearCompletedTasks;
    modalClose.onclick = closeModal;
    cancelBtn.onclick = closeModal;
    taskForm.onsubmit = saveTask;

    themeToggle.onclick = () => {
        isDarkMode = !isDarkMode;
        localStorage.setItem('theme', isDarkMode ? 'dark' : 'light');
        applyTheme();
    };

    searchInput.oninput = (e) => {
        searchQuery = e.target.value;
        renderTasks();
    };

    navItems.forEach(item => {
        item.onclick = (e) => {
            e.preventDefault();
            navItems.forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            currentFilter = item.dataset.filter;

            const titles = {
                all: 'Semua Tugas',
                today: 'Hari Ini',
                upcoming: 'Mendatang',
                completed: 'Tugas Selesai',
                overdue: 'Terlambat'
            };
            pageTitle.textContent = titles[currentFilter];
            pageSubtitle.textContent = `Kelola tugas ${titles[currentFilter].toLowerCase()} Anda`;

            renderTasks();
            renderCategories();
        };
    });

    // Mobile Menu
    menuToggle.onclick = () => sidebar.classList.toggle('active');

    // Close sidebar on click outside (mobile)
    document.addEventListener('click', (e) => {
        if (window.innerWidth <= 1024 && !sidebar.contains(e.target) && !menuToggle.contains(e.target)) {
            sidebar.classList.remove('active');
        }
    });

    // Tag, tugas berulang, pengingat
    $('tag-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            addTag(e.target.value);
            e.target.value = '';
        } else if (e.key === 'Backspace' && !e.target.value && currentTags.length) {
            currentTags.pop();
            renderTagChips();
        }
    });
    $('tag-input').addEventListener('blur', (e) => {
        if (e.target.value.trim()) { addTag(e.target.value); e.target.value = ''; }
    });
    $('task-repeat').onchange = (e) => { $('repeat-interval').disabled = !e.target.checked; };
    $('task-reminder').onchange = (e) => { if (e.target.value !== 'none') ensureNotificationPermission(); };

    // Category Modal Logic
    $('add-category-btn').onclick = () => categoryModal.classList.add('active');
    $('category-modal-close').onclick = () => categoryModal.classList.remove('active');
    $('category-cancel-btn').onclick = () => categoryModal.classList.remove('active');
    $('category-form').onsubmit = addCategory;

    // Auth
    document.querySelectorAll('.auth-tab').forEach(tab => {
        tab.onclick = () => setAuthMode(tab.dataset.mode);
    });
    $('auth-forgot').onclick = () => setAuthMode('forgot');
    $('auth-back').onclick = () => setAuthMode('login');
    $('auth-form').onsubmit = handleAuthSubmit;
    $('google-login-btn').onclick = handleGoogleLogin;
    $('logout-btn').onclick = logout;
    $('reset-form').onsubmit = handleResetPassword;

    // Profil
    $('open-profile-btn').onclick = openProfileModal;
    $('profile-modal-close').onclick = closeProfileModal;
    $('profile-form').onsubmit = saveProfile;
    $('email-form').onsubmit = changeEmail;
    $('password-form').onsubmit = changePassword;
    $('avatar-change-btn').onclick = () => $('avatar-input').click();
    $('avatar-input').onchange = handleAvatarSelected;
    $('avatar-remove-btn').onclick = removeAvatar;
    $('delete-account-btn').onclick = deleteAccount;
}

// =====================================================================
// START
// =====================================================================
function init() {
    updateDate();
    applyTheme();
    setupEventListeners();
    setAuthMode('login');
    updateStats();
    initAuth();
}

init();
