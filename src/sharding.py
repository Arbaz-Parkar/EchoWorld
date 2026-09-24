from .db import mongo_client


shard_a = mongo_client["echoworld"]["npc_history_shard_a"]
shard_b = mongo_client["echoworld"]["npc_history_shard_b"]


def shard_for(npc_id):
    npc_number = int(npc_id.split("_")[1])
    return shard_a if npc_number % 2 == 0 else shard_b


def populate_shards(history_col):
    for doc in history_col.find():
        target = shard_for(doc["npc_id"])
        doc_copy = dict(doc)
        doc_copy.pop("_id", None)
        target.insert_one(doc_copy)


def scatter_gather_query(npc_id, tick_range):
    target = shard_for(npc_id)
    return list(target.find({
        "npc_id": npc_id,
        "tick": {"$gte": tick_range[0], "$lte": tick_range[1]}
    }).sort("tick", 1))