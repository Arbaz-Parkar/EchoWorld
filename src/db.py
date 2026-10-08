import pymongo
import redis

from . import config

mongo_client = pymongo.MongoClient(config.MONGO_URI)
db = mongo_client["echoworld"]

shards = [db["npc_history_shard_a"], db["npc_history_shard_b"]]
SHARD_LABELS = ["Shard A", "Shard B"]

redis_client = redis.Redis(
    host=config.REDIS_HOST,
    port=config.REDIS_PORT,
    decode_responses=True,
)

GEO_KEY = "npc:live:positions"


def shard_index(npc_id):
    return int(npc_id.split("_")[1]) % 2


def shard_for(npc_id):
    return shards[shard_index(npc_id)]


def ensure_indexes():
    for col in shards:
        col.create_index([("location", "2dsphere")])
        col.create_index([("npc_id", 1), ("tick", 1)])
        col.create_index([("npc_id", 1), ("run_id", 1), ("tick", 1)])
        col.create_index([("run_id", 1), ("tick", 1)])
        col.create_index([("tick", 1)])


def reset_all():
    for col in shards:
        col.delete_many({})
    for key in redis_client.scan_iter("npc:live:*"):
        redis_client.delete(key)
    redis_client.delete("sim:tick")


def clear_live_state():
    """Clear the live view when a new run is configured, keeping Mongo history."""
    keys = list(redis_client.scan_iter("npc:live:*"))
    if keys:
        redis_client.delete(*keys)
    redis_client.delete(GEO_KEY, "sim:tick")


ensure_indexes()
