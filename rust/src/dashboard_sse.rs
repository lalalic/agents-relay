//! Observation-only broadcast owner. No subscriber can block Relay scheduling.
use std::sync::{Arc,atomic::{AtomicU64,AtomicUsize,Ordering},mpsc::{self,Receiver,SyncSender,TrySendError}};

enum Message { Subscribe(SyncSender<String>,SyncSender<()>), Frame(u64,String) }

#[derive(Clone)]
pub struct DashboardSse {
    tx:SyncSender<Message>,
    generation:Arc<AtomicU64>,
    subscribers:Arc<AtomicUsize>,
}
impl DashboardSse {
    pub fn new()->Self{
        let (tx,rx)=mpsc::sync_channel(256);
        let generation=Arc::new(AtomicU64::new(0));
        let observed_generation=Arc::clone(&generation);
        let subscribers=Arc::new(AtomicUsize::new(0));
        let count=Arc::clone(&subscribers);
        std::thread::spawn(move||broadcast(rx,observed_generation,count,Vec::new()));
        Self{tx,subscribers,generation}
    }
    pub fn subscribe(&self)->Receiver<String>{
        let (client,receiver)=mpsc::sync_channel(256);
        let (ready,registered)=mpsc::sync_channel(1);
        if self.tx.send(Message::Subscribe(client,ready)).is_ok(){let _=registered.recv();}
        receiver
    }
    pub fn publish_event(&self,event:&serde_json::Value){
        let payload=serde_json::json!({"event":event});
        self.publish(format!("event: relay\ndata: {payload}\n\n"));
    }
    pub fn publish(&self,frame:String){
        if !self.has_subscribers(){return;}
        let epoch=self.generation.load(Ordering::Acquire);
        if let Err(TrySendError::Full(_))=self.tx.try_send(Message::Frame(epoch,frame)){
            self.generation.fetch_add(1,Ordering::AcqRel);
        }
    }
    pub fn has_subscribers(&self)->bool{self.subscribers.load(Ordering::Acquire)>0}
}
fn broadcast(rx:Receiver<Message>,observed_generation:Arc<AtomicU64>,count:Arc<AtomicUsize>,
    mut clients:Vec<SyncSender<String>>){
    let mut current=0;
    loop{
        // Recheck generation even when the last queued frame was
        // consumed just before a publisher marked the overflow.
        let message=match rx.recv_timeout(std::time::Duration::from_millis(100)){
            Ok(message)=>Some(message),
            Err(mpsc::RecvTimeoutError::Timeout)=>None,
            Err(mpsc::RecvTimeoutError::Disconnected)=>break,
        };
        let latest=observed_generation.load(Ordering::Acquire);
        if current!=latest{
            // Ingress overflow means a gap for every existing client.
            // Close their streams; reconnect obtains durable state.
            clients.clear();count.store(0,Ordering::Release);current=latest;
        }
        let Some(message)=message else{continue;};
        match message{
            Message::Subscribe(client,ready)=>{
                clients.push(client);count.store(clients.len(),Ordering::Release);
                let _=ready.send(());
            },
            Message::Frame(epoch,frame)=>{
                if epoch!=current{continue;}
                // A lagging client reconnects and reloads authoritative
                // SQLite/history rather than accumulating unbounded data.
                clients.retain(|client|match client.try_send(frame.clone()){
                    Ok(())=>true,Err(TrySendError::Full(_)|TrySendError::Disconnected(_))=>false,
                });
                count.store(clients.len(),Ordering::Release);
            }
        }
    }
    count.store(0,Ordering::Release);
}

impl Default for DashboardSse{fn default()->Self{Self::new()}}

#[cfg(test)]
mod tests{
    use super::*;
    use std::time::Duration;
    #[test]
    fn ingress_overflow_disconnects_existing_stream_and_allows_recovery(){
        // Delay the broadcast owner while a real bounded ingress fills.
        let (tx,rx)=mpsc::sync_channel(1);
        let (client,stream)=mpsc::sync_channel(1);
        let hub=DashboardSse{tx,generation:Arc::new(AtomicU64::new(0)),
            subscribers:Arc::new(AtomicUsize::new(1))};
        hub.publish("queued".into());hub.publish("overflow".into());
        assert_eq!(hub.generation.load(Ordering::Acquire),1);
        let generation=Arc::clone(&hub.generation);let count=Arc::clone(&hub.subscribers);
        let owner=std::thread::spawn(move||broadcast(rx,generation,count,vec![client]));
        assert!(matches!(stream.recv_timeout(Duration::from_secs(1)),
            Err(mpsc::RecvTimeoutError::Disconnected)));
        let fresh=hub.subscribe();hub.publish("recovered".into());
        assert_eq!(fresh.recv_timeout(Duration::from_secs(1)).unwrap(),"recovered");
        drop(hub);owner.join().unwrap();
    }
    #[test]
    fn lagging_client_is_disconnected_without_blocking_other_clients(){
        let hub=DashboardSse::new();let slow=hub.subscribe();let fast=hub.subscribe();
        for i in 0..300{
            hub.publish(i.to_string());
            assert_eq!(fast.recv_timeout(Duration::from_secs(1)).unwrap(),i.to_string());
        }
        for i in 0..256{assert_eq!(slow.recv().unwrap(),i.to_string());}
        assert!(slow.recv_timeout(Duration::from_secs(1)).is_err());
        let fresh=hub.subscribe();hub.publish("new".into());
        assert_eq!(fresh.recv_timeout(Duration::from_secs(1)).unwrap(),"new");
    }
}
