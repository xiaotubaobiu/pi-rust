import sys
p = "src/chord/consumer.rs"
s = open(p, encoding="utf8").read()
old = """        let subscription = Arc::new(self.provider.subscribe(service_id, ServiceMode::Keyed, {
            let pump_listener = pump_listener.clone();
            move |update, context| pump_listener(update, context)
        })?);
        let snapshot = subscription.snapshot().clone();
        let pump_subscription = subscription.clone();
        std::thread::spawn(move || loop {
            match receiver.recv() {
                Ok(PumpMessage::Update(update, context)) => {
                    let _ = pump_listener(&update, &context);
                }
                Ok(PumpMessage::Close) | Err(_) => break,
            }
        });"""
new = """        let subscription = Arc::new(self.provider.subscribe(service_id, ServiceMode::Keyed, {
            let pump_listener = pump_listener.clone();
            move |update, context| pump_listener(update, context)
        })?);
        let snapshot = subscription.snapshot().clone();
        let pump_subscription = subscription.clone();
        std::thread::spawn(move || loop {
            match receiver.recv() {
                Ok(PumpMessage::Update(update, context)) => {
                    let _ = listener(&update, &context);
                }
                Ok(PumpMessage::Close) | Err(_) => break,
            }
        });"""
assert old in s, "pump body not found"
s = s.replace(old, new)
open(p, "w", encoding="utf8", newline="\n").write(s)
print("ok")
