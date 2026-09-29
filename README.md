# EchoWorld

A spatiotemporal NoSQL memory store for game NPCs, with a live browser
front end. Redis holds each character's current position and activity;
MongoDB (split across two shards) holds their full history, queryable by
time and by location.

## Run it

1. Start the databases: `docker compose up -d`
2. Create a virtual environment and install dependencies:
   `python -m venv .venv` then activate it, then `pip install -r requirements.txt`
3. Start the server: `python run.py`
4. Open `http://127.0.0.1:8000` in your browser.