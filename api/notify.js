const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const T = process.env.TABLE_PREFIX || 'ct'

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-password')
  if (req.method === 'OPTIONS') return res.status(200).end()

  if (req.headers['x-admin-password'] !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Unauthorized' })

  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' })

  const { data: teams, error } = await supabase
    .from(`${T}_teams`).select('id, name, phone, partner_status')
  if (error) return res.status(500).json({ error: error.message })

  const eventName   = process.env.EVENT_NAME    || 'Tournament'
  const venmoHandle = process.env.VENMO_HANDLE  || ''
  const entryFee    = parseInt(process.env.ENTRY_FEE || '0')
  const venmoLink   = `https://venmo.com/${venmoHandle}?txn=pay&amount=${entryFee}&note=${encodeURIComponent(eventName)}`
  const message     = `Hi! You're registered for the ${eventName}. Entry fee is $${entryFee}/team ($${Math.round(entryFee / 2)}/person). Please pay via Venmo: ${venmoLink}`

  const sid = process.env.TWILIO_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  const from = process.env.TWILIO_PHONE
  const auth = Buffer.from(`${sid}:${token}`).toString('base64')
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`

  const results = { sent: 0, failed: 0, skipped: 0, sentList: [], failedList: [] }

  // If a specific team_id is provided, only text that team
  const targetId = req.body?.team_id || null
  const targetTeams = targetId ? teams.filter(t => t.id === targetId) : teams

  for (const team of targetTeams) {
    if (!team.phone) { results.skipped++; continue }

    let phone = team.phone.replace(/\D/g, '')
    if (phone.length === 10) phone = '1' + phone
    else if (phone.length === 11 && !phone.startsWith('1')) phone = '1' + phone
    if (!phone.startsWith('+')) phone = '+' + phone

    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ From: from, To: phone, Body: message })
      })
      if (r.ok) { results.sent++; results.sentList.push({ name: team.name, phone: team.phone }) }
      else { results.failed++; results.failedList.push({ name: team.name, phone: team.phone }) }
    } catch (e) {
      results.failed++; results.failedList.push({ name: team.name, phone: team.phone })
    }
  }

  return res.json({ success: true, ...results })
}
