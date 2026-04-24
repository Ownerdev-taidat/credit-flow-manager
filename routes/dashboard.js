const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireAuth } = require('./auth');

// GET /api/dashboard
router.get('/', requireAuth, async (req, res) => {
  try {
  const userId = req.session.userId;
  const admins = await db.prepare('SELECT * FROM admins WHERE status = ? AND (user_id = ? OR user_id IS NULL)').all('active', userId);
  const now = new Date();

  let totalCredits = 0, totalCreditsUsed = 0, totalStorageTb = 0, totalStorageUsed = 0, totalMembers = 0;

  const adminOverviews = [];
  for (const admin of admins) {
    const resetDay = admin.credit_reset_day;
    let periodStart;
    if (now.getDate() >= resetDay) { periodStart = new Date(now.getFullYear(), now.getMonth(), resetDay); }
    else { periodStart = new Date(now.getFullYear(), now.getMonth() - 1, resetDay); }
    const periodStartStr = periodStart.toISOString().split('T')[0];

    const creditUsage = await db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM credit_logs WHERE admin_id = ? AND log_date >= ?').get(admin.id, periodStartStr);

    let creditsUsed, creditsRemaining;
    if (admin.credits_remaining_actual > 0) {
      creditsRemaining = admin.credits_remaining_actual;
      creditsUsed = admin.total_monthly_credits - admin.credits_remaining_actual;
    } else {
      creditsUsed = parseInt(creditUsage.total);
      creditsRemaining = admin.total_monthly_credits - parseInt(creditUsage.total);
    }

    const members = await db.prepare(`
            SELECT m.*,
                COALESCE((SELECT cl.amount FROM credit_logs cl WHERE cl.member_id = m.id ORDER BY cl.id DESC LIMIT 1), 0) as credits_used,
                COALESCE((SELECT sl.total_gb FROM storage_logs sl WHERE sl.member_id = m.id ORDER BY sl.log_date DESC, sl.id DESC LIMIT 1), 0) as storage_gb
            FROM members m WHERE m.admin_id = ? AND m.status = 'active' ORDER BY m.joined_at ASC
        `).all(admin.id);

    const storageUsed = members.reduce((sum, m) => sum + parseFloat(m.storage_gb), 0);

    totalCredits += admin.total_monthly_credits;
    totalCreditsUsed += creditsUsed;
    totalStorageTb += admin.total_storage_tb;
    totalStorageUsed += storageUsed;
    totalMembers += members.length;

    adminOverviews.push({
      id: admin.id, email: admin.email, name: admin.name, avatar_color: admin.avatar_color,
      has_totp: !!admin.totp_secret,
      credits: { total: admin.total_monthly_credits, used: creditsUsed, remaining: creditsRemaining, percent: Math.round((creditsUsed / admin.total_monthly_credits) * 100) },
      storage: { total_tb: admin.total_storage_tb, used_gb: storageUsed, percent: Math.round((storageUsed / (admin.total_storage_tb * 1024)) * 100) },
      members, member_count: members.length, max_members: admin.max_members, slots_available: admin.max_members - members.length
    });
  }

  const recentCredits = await db.prepare(`
        SELECT cl.*, m.name as member_name, m.avatar_color, a.name as admin_name, a.email as admin_email
        FROM credit_logs cl LEFT JOIN members m ON m.id = cl.member_id JOIN admins a ON a.id = cl.admin_id
        WHERE (a.user_id = ? OR a.user_id IS NULL) ORDER BY cl.created_at DESC LIMIT 10
    `).all(userId);

  // Find members who exceeded their credit limit
  const overLimitMembers = [];
  for (const ao of adminOverviews) {
    for (const m of ao.members) {
      const used = m.credits_used || 0;
      const limit = m.credit_limit || 0;
      if (limit > 0 && used >= limit) {
        overLimitMembers.push({
          member_id: m.id,
          member_name: m.name,
          member_email: m.email,
          credits_used: used,
          credit_limit: limit,
          admin_id: ao.id,
          admin_name: ao.name,
          admin_email: ao.email,
          avatar_color: m.avatar_color
        });
      }
    }
  }

  // Find members expiring within 1 day or already expired
  const expiringMembers = [];
  const todayStr = new Date().toISOString().split('T')[0];
  const tomorrowDate = new Date();
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr = tomorrowDate.toISOString().split('T')[0];

  for (const ao of adminOverviews) {
    for (const m of ao.members) {
      if (!m.end_date) continue;
      // Safely convert to string — PG returns Date object, SQLite returns string
      const endDateRaw = m.end_date instanceof Date ? m.end_date.toISOString() : String(m.end_date);
      const endDate = endDateRaw.split('T')[0];
      const startDateRaw = m.start_date instanceof Date ? m.start_date.toISOString() : String(m.start_date || '');
      const startDate = startDateRaw.split('T')[0];
      if (endDate <= tomorrowStr) {
        const isExpired = endDate < todayStr;
        const isExpiringToday = endDate === todayStr;
        expiringMembers.push({
          member_id: m.id,
          member_name: m.name,
          member_email: m.email,
          start_date: startDate,
          end_date: endDate,
          is_expired: isExpired,
          is_expiring_today: isExpiringToday,
          admin_id: ao.id,
          admin_name: ao.name,
          admin_email: ao.email,
          avatar_color: m.avatar_color
        });
      }
    }
  }

  res.json({
    totals: { admins: admins.length, members: totalMembers, credits: totalCredits, credits_used: totalCreditsUsed, credits_remaining: totalCredits - totalCreditsUsed, storage_tb: totalStorageTb, storage_used_gb: totalStorageUsed },
    admins: adminOverviews,
    recent_activity: recentCredits,
    over_limit_members: overLimitMembers,
    expiring_members: expiringMembers
  });
  } catch (err) {
    console.error('[Dashboard] Error:', err.message, err.stack);
    res.status(500).json({ error: 'Dashboard error: ' + err.message });
  }
});

// GET /api/dashboard/search - Search emails for autocomplete
router.get('/search', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q || q.length < 1) return res.json([]);

  const results = [];

  // Search admin emails
  const admins = await db.prepare(
    "SELECT id, email, name, avatar_color FROM admins WHERE status = 'active' AND (user_id = ? OR user_id IS NULL) AND LOWER(email) LIKE ?"
  ).all(userId, `%${q}%`);

  for (const a of admins) {
    results.push({
      type: 'admin',
      email: a.email,
      name: a.name,
      admin_id: a.id,
      admin_name: a.name,
      avatar_color: a.avatar_color
    });
  }

  // Search member emails and names
  const members = await db.prepare(
    "SELECT m.id, m.email, m.name, m.avatar_color, m.admin_id, a.name as admin_name FROM members m JOIN admins a ON a.id = m.admin_id WHERE m.status IN ('active', 'pending') AND a.status = 'active' AND (a.user_id = ? OR a.user_id IS NULL) AND (LOWER(m.email) LIKE ? OR LOWER(m.name) LIKE ?)"
  ).all(userId, `%${q}%`, `%${q}%`);

  for (const m of members) {
    results.push({
      type: 'member',
      email: m.email,
      name: m.name,
      admin_id: m.admin_id,
      admin_name: m.admin_name,
      avatar_color: m.avatar_color
    });
  }

  res.json(results.slice(0, 15)); // Max 15 suggestions
});

module.exports = router;
