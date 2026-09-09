import { loadConfig } from '../config.js'
import { openDatabase } from './database.js'

const config = loadConfig()
const database = openDatabase(config)

try {
  database.migrate()
} finally {
  database.close()
}
