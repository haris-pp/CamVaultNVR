import sqlite3

def init_db():
    conn = sqlite3.connect("app_database.db")
    c = conn.cursor()

    # Table for sources
    c.execute("""
    CREATE TABLE IF NOT EXISTS input_sources (
        id   INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        record_folder_name TEXT NOT NULL,
        codec     TEXT DEFAULT 'NA',
        url  TEXT NOT NULL,
        sub_url TEXT DEFAULT ''
    )
    """)

    # Table for schedules
    c.execute("""
    CREATE TABLE IF NOT EXISTS schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL UNIQUE,
        schedule_slots TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        pid INTEGER DEFAULT 0,
        status_msg TEXT DEFAULT '',
        update_time TEXT NOT NULL
            DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now', 'localtime')),
        FOREIGN KEY(source_id) REFERENCES input_sources(id)
    )
    """)


    # Table for settings
    c.execute("""
    CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )
    """)

    # Insert defaults if not exist
    defaults = [
        ("recording_folder", "RECORD"),
        ("chunk_duration", "10")
    ]
    for key, value in defaults:
        c.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (key, value))

    conn.commit()
    conn.close()
    print("Database and tables created (input_sources + schedules + settings).")

# Allow running standalone
if __name__ == "__main__":
    init_db()    