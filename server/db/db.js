// server/db/db.js
import sqlite3 from 'sqlite3'
import { open } from 'sqlite'

const dbPromise = open({
  filename: './db.sqlite',
  driver: sqlite3.Database,
})

export default await dbPromise