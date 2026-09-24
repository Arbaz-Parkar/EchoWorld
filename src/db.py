import pymongo
import redis

from . import config

mongo_client = pymongo.MongoClient(config.MONGO_URI)
db = mongo_client["echoworld"]
history_col = db["npc_history"]

history_col.create_index([("location", "2dsphere")])

redis_client = redis.Redis(
    host=config.REDIS_HOST,
    port=config.REDIS_PORT,
    decode_responses=True
)