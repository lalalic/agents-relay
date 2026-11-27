//! Observation-only broadcast owner. No subscriber can block Relay scheduling.
use std::sync::{Arc,atomic::{AtomicUsize,Ordering},mpsc::{self,Receiver,Sender,SyncSender,TrySendError}};

enum Message { Subscribe(SyncSender<String>,SyncSender<()>), Frame(String) }

#[derive(Clone)]
pub struct DashboardSse {
    tx:Sender<Message>,
    subscribers:Arc<AtomicUsize>,
}
impl DashboardSse {
    pub fn new()->Self{
        let (tx,rx)=mpsc::channel();
        let subscribers=Arc::new(AtomicUsize::new(0));
        let count=Arc::clone(&subscribers);
        std::thread::spawn(move||{
            let mut clients:Vec<SyncSender<String>>=Vec::new();
            while let Ok(message)=rx.recv(){
                match message{
                    Message::Subscribe(client,ready)=>{
                        clients.push(client);count.store(clients.len(),Ordering::Release);
                        let _=ready.send(());
                    },
                    Message::Frame(frame)=>{
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
        });
        Self{tx,subscribers}
    }
    pub fn subscribe(&self)->Receiver<String>{
        let (client,receiver)=mpsc::sync_channel(256);
        let (ready,registered)=mpsc::sync_channel(1);
        if self.tx.send(Message::Subscribe(client,ready)).is_ok(){let _=registered.recv();}
        receiver
    }
    pub fn publish(&self,frame:String){let _=self.tx.send(Message::Frame(frame));}
    pub fn has_subscribers(&self)->bool{self.subscribers.load(Ordering::Acquire)>0}
}
impl Default for DashboardSse{fn default()->Self{Self::new()}}

#[cfg(test)]
mod tests{
    use super::*;
    use std::time::Duration;
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
