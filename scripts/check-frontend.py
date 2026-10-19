#!/usr/bin/env python3
"""Offline contract-derived vectors. No network, wallet, deployment or transactions."""
import base64
import hashlib
from html.parser import HTMLParser
import json
import pathlib
import re
import struct
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
RUST = (ROOT / 'programs/clear-milestone/src/lib.rs').read_text()

class Markup(HTMLParser):
    def __init__(self):
        super().__init__(); self.ids = []; self.actions = []
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if 'id' in attrs: self.ids.append(attrs['id'])
        if 'data-action' in attrs: self.actions.append(attrs['data-action'])

markup = Markup(); markup.feed((ROOT / 'app/index.html').read_text())
assert len(markup.ids) == len(set(markup.ids)), 'Duplicate HTML IDs'
js = (ROOT / 'app/app.js').read_text()
assert set(re.findall(r"\$\('([^']+)'\)", js)) <= set(markup.ids), 'Missing DOM target'
assert 'innerHTML' not in js and 'localStorage' not in js and 'sessionStorage' not in js
assert hashlib.sha256((ROOT / 'app/vendor/solana-web3-1.98.4.min.js').read_bytes()).hexdigest() == '09cdbea951b2ed0e11bcbe3aeb1ee9f035f9fb51ed212aca645475ae82688cc3'

def normalize(t):
    return re.sub(r'\s+', '', t)

program = RUST.split('#[program]', 1)[1].split('#[derive(Accounts)]', 1)[0]
schemas = {}
for name, tail in re.findall(r'pub fn (\w+)\(ctx: Context<\w+>(.*?)\) -> Result<\(\)>', program, re.S):
    schemas[name] = [[n, normalize(t)] for n, t in re.findall(r'(\w+):\s*(\[u8;\s*32\]|u64|i64|u16|String)', tail)]
assert len(schemas) == 7
assert set(markup.actions) == set(schemas) - {'initialize_sprint'}
fields = [[n, normalize(t)] for n, t in re.findall(r'pub (\w+):\s*([^,]+),', RUST.split('pub struct SprintEscrow {')[1].split('\n}')[0])]
space = sum(int(n) for n in re.search(r'pub const SPACE: usize = ([\d +]+);', RUST)[1].split('+'))
assert space == 386
assert 'seeds = [b"sprint", client.key().as_ref(), contractor.key().as_ref(), &sprint_id.to_le_bytes()]' in RUST
assert 'bump = sprint_escrow.bump' in RUST

def metas(struct_name):
    body = RUST.split(f'pub struct {struct_name}')[1].split('\n}')[0]
    result = []
    cursor = 0
    for m in re.finditer(r'pub (\w+): ([^\n]+)', body):
        attrs = body[cursor:m.start()]
        result.append([m[1], 'mut' in attrs or 'init,' in attrs, 'Signer<' in m[2]])
        cursor = m.end()
    return result

ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
def b58(b):
    n = int.from_bytes(b, 'big'); out = ''
    while n:
        n, r = divmod(n, 58); out = ALPHABET[r] + out
    return '1' * (len(b) - len(b.lstrip(b'\0'))) + out

def on_curve(raw):
    prime = 2**255 - 19
    y = int.from_bytes(raw, 'little') & (2**255 - 1)
    d = -121665 * pow(121666, prime-2, prime) % prime
    xx = (y*y - 1) * pow(d*y*y + 1, prime-2, prime) % prime
    return xx == 0 or pow(xx, (prime-1)//2, prime) == 1

client, contractor, arbiter, program_id = [bytes([n])*32 for n in (1,2,3,4)]
sprint_id = 2**64-1
for bump in range(255,-1,-1):
    address = hashlib.sha256(b'sprint'+client+contractor+struct.pack('<Q',sprint_id)+bytes([bump])+program_id+b'ProgramDerivedAddress').digest()
    if not on_curve(address): break

values = {'sprint_id': str(sprint_id), 'amount_lamports': str(2**64-1), 'kill_fee_bps':'5000', 'arbiter_fee_bps':'500', 'review_window_secs':'2592000', 'spec_hash':list(range(32)), 'deliverable_hash':[171]*32, 'deliverable_uri':'https://example.test/żółć/交付', 'dispute_hash':[205]*32, 'contractor_share_bps':'10000'}
def encode(type_, value):
    if type_ == '[u8;32]': return bytes(value)
    if type_ == 'String':
        b=value.encode(); return struct.pack('<I',len(b))+b
    return struct.pack({'u64':'<Q','i64':'<q','u16':'<H','u8':'<B'}[type_],int(value))
vectors = {}
for name, args in schemas.items():
    b = hashlib.sha256(('global:'+name).encode()).digest()[:8]
    for field, type_ in args: b += encode(type_,values[field])
    vectors[name] = b.hex()
accounts=[]
for uri in ['',values['deliverable_uri'],'ż'*64]:
    fields_values={**values,'client':client,'contractor':contractor,'arbiter':arbiter,'created_at':'-123','submitted_at':'456','auto_release_at':'2592456','deliverable_uri':uri,'status':'5','bump':str(bump)}
    raw=hashlib.sha256(b'account:SprintEscrow').digest()[:8]
    for field,type_ in fields: raw += fields_values[field] if type_=='Pubkey' else encode(type_,fields_values[field])
    assert len(raw)==258+len(uri.encode())
    accounts.append({'uri':uri,'hex':raw.ljust(space,b'\0').hex()})

# Compile the actual shared Rust rule source (no Anchor dependency) for action/time/payout oracles.
rules=RUST.split('// BEGIN SHARED RULES')[1].split('pub mod rules {',1)[1].split('// END SHARED RULES')[0]
rules='pub mod rules {'+rules
harness=r'''
fn main() {
 for status in 0..=7u8 { for role in 0..4u8 { for now in [99i64,100,101] { for action in 0..6u8 {
  let r=match role {0=>rules::Role::Client,1=>rules::Role::Contractor,2=>rules::Role::Arbiter,_=>rules::Role::Stranger};
  let a=match action {0=>rules::Action::Submit{uri_bytes:0},1=>rules::Action::Approve,2=>rules::Action::Claim,3=>rules::Action::Cancel,4=>rules::Action::Dispute,_=>rules::Action::Resolve{contractor_share_bps:5000}};
  println!("A,{},{},{},{},{}",status,role,now,action,rules::transition(status,r,a,100,1000,200,300,100,now).is_ok());
 }}}}
 for amount in [1u64,10001,u64::MAX] { for share in [0u16,1,5000,9999,10000] {
  let o=rules::transition(5,rules::Role::Arbiter,rules::Action::Resolve{contractor_share_bps:share},amount,5000,500,300,100,99).unwrap();
  println!("P,{},{},{},{},{}",amount,share,o.to_contractor,o.to_client,o.arbiter_fee);
 }}
}
'''
with tempfile.TemporaryDirectory(prefix='clearmilestone-check-') as tmp:
    src=pathlib.Path(tmp)/'rules.rs'; src.write_text(rules+harness)
    executable=pathlib.Path(tmp)/'rules'
    subprocess.run(['rustc','--edition=2021',str(src),'-o',str(executable)],check=True)
    oracle=subprocess.check_output([str(executable)],text=True).splitlines()
    fixture={'schemas':schemas,'fields':fields,'space':space,'metas':{'initialize':metas('InitializeSprint'),'act':metas('Act')},'values':values,'vectors':vectors,'accounts':accounts,'pda':b58(address),'bump':bump,'program':b58(program_id),'client':b58(client),'contractor':b58(contractor),'arbiter':b58(arbiter),'oracle':oracle,'signature_vectors':[[list(b),b58(b)] for b in [bytes(64),bytes(range(64)),bytes([255])*64]]}
    path=pathlib.Path(tmp)/'vectors.json';path.write_text(json.dumps(fixture))
    subprocess.run(['node','--check','app/app.js'],cwd=ROOT,check=True)
    subprocess.run(['node','scripts/check-frontend.cjs',str(path)],cwd=ROOT,check=True)
