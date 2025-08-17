// server/db/init.js
import fs from 'fs'
import db from './db.js'

const initSql = fs.readFileSync('./db/init.sql', 'utf-8')

db.exec(initSql, (err) => {
  if (err) {
    console.error('Fout bij initialiseren database:', err)
    process.exit(1)
  } else {
    console.log('✅ Database succesvol geïnitialiseerd.')
    process.exit(0)
  }
})