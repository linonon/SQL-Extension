"""
Kafka 测试数据生成脚本.
连接本地 Kafka, 创建 topic 并灌入测试消息.
"""

import json
import random
import time
import uuid
from datetime import datetime, timezone, timedelta

from kafka import KafkaProducer
from kafka.admin import KafkaAdminClient, NewTopic
from kafka.errors import TopicAlreadyExistsError


BOOTSTRAP_SERVERS = "localhost:9092"

TOPICS = [
    {"name": "user-events", "partitions": 3, "description": "用户行为事件"},
    {"name": "order-logs", "partitions": 2, "description": "订单日志"},
    {"name": "system-metrics", "partitions": 1, "description": "系统指标"},
]

EVENTS = ["page_view", "click", "scroll", "search", "add_to_cart", "checkout", "login", "logout"]
PAGES = ["/products", "/home", "/cart", "/checkout", "/profile", "/settings", "/search"]
ORDER_STATUSES = ["created", "paid", "shipped", "delivered", "cancelled"]
SKUS = ["SKU-A", "SKU-B", "SKU-C", "SKU-D", "SKU-E"]
HOSTNAMES = ["web-01", "web-02", "api-01", "api-02", "worker-01"]


def create_topics(admin):
    """创建 topic, 已存在则跳过."""
    print("Creating topics...")
    for t in TOPICS:
        topic = NewTopic(
            name=t["name"],
            num_partitions=t["partitions"],
            replication_factor=1,
        )
        try:
            admin.create_topics([topic])
            print(f"  {t['name']} ({t['partitions']} partitions) - OK")
        except TopicAlreadyExistsError:
            print(f"  {t['name']} ({t['partitions']} partitions) - already exists, skipped")


def gen_user_event(i):
    """生成用户行为事件消息."""
    user_id = f"u-{random.randint(1, 20):03d}"
    ts = datetime.now(timezone.utc) - timedelta(minutes=random.randint(0, 120))
    return (
        user_id,
        {
            "userId": user_id,
            "event": random.choice(EVENTS),
            "page": random.choice(PAGES),
            "sessionId": str(uuid.uuid4())[:8],
            "ts": ts.strftime("%Y-%m-%dT%H:%M:%SZ"),
        },
        [
            ("source", b"web"),
            ("traceId", str(uuid.uuid4()).encode()),
        ],
    )


def gen_order_log(i):
    """生成订单日志消息."""
    order_id = f"ord-{1001 + i}"
    amount = round(random.uniform(9.99, 999.99), 2)
    items = random.sample(SKUS, k=random.randint(1, 3))
    return (
        order_id,
        {
            "orderId": order_id,
            "status": random.choice(ORDER_STATUSES),
            "amount": amount,
            "items": items,
            "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        },
        None,
    )


def gen_system_metric(i):
    """生成系统指标消息."""
    hostname = random.choice(HOSTNAMES)
    return (
        hostname,
        {
            "hostname": hostname,
            "cpu": round(random.uniform(5.0, 95.0), 1),
            "memory": round(random.uniform(30.0, 95.0), 1),
            "disk": round(random.uniform(20.0, 90.0), 1),
            "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        },
        None,
    )


GENERATORS = {
    "user-events": (50, gen_user_event),
    "order-logs": (30, gen_order_log),
    "system-metrics": (20, gen_system_metric),
}


def produce_messages(producer):
    """向各 topic 灌入测试消息."""
    print("Producing messages...")
    total = 0
    for topic_name, (count, gen_fn) in GENERATORS.items():
        for i in range(count):
            key, value, headers = gen_fn(i)
            producer.send(
                topic_name,
                key=key.encode(),
                value=json.dumps(value).encode(),
                headers=headers if headers else [],
            )
        producer.flush()
        print(f"  {topic_name}: {count} messages sent")
        total += count
    return total


def main():
    print(f"Connecting to Kafka at {BOOTSTRAP_SERVERS}...")

    admin = KafkaAdminClient(bootstrap_servers=BOOTSTRAP_SERVERS)
    create_topics(admin)
    admin.close()

    producer = KafkaProducer(bootstrap_servers=BOOTSTRAP_SERVERS)
    total = produce_messages(producer)
    producer.close()

    print(f"Done. Total: {total} messages across {len(TOPICS)} topics.")


if __name__ == "__main__":
    main()
