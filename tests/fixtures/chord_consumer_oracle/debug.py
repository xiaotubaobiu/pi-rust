p = "src/chord/consumer.rs"
s = open(p, encoding="utf8").read()
s = s.replace("""    fn deliver(self: &Arc<Self>, update: &ServiceProviderUpdate, context: &Context) {
        if self.closed.load(Ordering::SeqCst) {
            return;
        }""", """    fn deliver(self: &Arc<Self>, update: &ServiceProviderUpdate, context: &Context) {
        eprintln!("DEBUG deliver: {:?}", update.to_json());
        if self.closed.load(Ordering::SeqCst) {
            return;
        }""")
s = s.replace("""        let bound = self.lock().bound;
        if bound {
            let revision = self.lock().revision;""", """        let bound = self.lock().bound;
        eprintln!("DEBUG observe_core: bound={bound}");
        if bound {
            let revision = self.lock().revision;""")
s = s.replace("""        let pump_subscription = subscription.clone();
        std::thread::spawn(move || loop {
            match receiver.recv() {
                Ok(PumpMessage::Update(update, context)) => {
                    let _ = listener(&update, &context);
                }""", """        let pump_subscription = subscription.clone();
        std::thread::spawn(move || loop {
            match receiver.recv() {
                Ok(PumpMessage::Update(update, context)) => {
                    eprintln!("DEBUG pump got update");
                    let _ = listener(&update, &context);
                }""")
s = s.replace("""            if let Err(error) = result {
                report_error(&error);
            }
            Ok(())
        });
        let subscription = self.transport.subscribe_keyed""", """            if let Err(error) = result {
                eprintln!("DEBUG start_singleton listener error: {error}");
                report_error(&error);
            }
            Ok(())
        });
        let subscription = self.transport.subscribe_keyed""")
open(p, "w", encoding="utf8", newline="\n").write(s)
print("ok")
