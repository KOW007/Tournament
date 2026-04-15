module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.method === 'OPTIONS') return res.status(200).end()
  res.json({
    eventName:   process.env.EVENT_NAME    || '2026 Pickleball Tournament',
    logo:        process.env.EVENT_LOGO    || '',
    accentColor: process.env.ACCENT_COLOR  || '#3a8fc1',
    venmoHandle: process.env.VENMO_HANDLE  || '',
    entryFee:    parseInt(process.env.ENTRY_FEE || '0'),
  })
}
