import {extensionSeed} from './extensions';
import {State,Product,Line,TODAY} from './domain';
const products:Product[]=[
 {id:'P001',name:'A4 80gsm Paper Ream',description:'Standard white paper, 500 sheets per ream',unit:'Piece',category:'Paper & sheets',brand:'',condition:'New',model:'500 sheets',hsn:'48025590',cost:150,price:199,tax:12,stock:50,low:10,warranty:0,supplier:'',serials:[],isSerialTracked:false},
 {id:'P002',name:'A3 90gsm Paper Ream',description:'Bright white A3 paper for laser and inkjet printers, 500 sheets',unit:'Piece',category:'Paper & sheets',brand:'',condition:'New',model:'500 sheets',hsn:'48025590',cost:280,price:349,tax:12,stock:30,low:6,warranty:0,supplier:'',serials:[],isSerialTracked:false},
 {id:'P003',name:'SRA3 170gsm Art Paper',description:'Coated art paper for high quality colour printing, 250 sheets',unit:'Piece',category:'Paper & sheets',brand:'',condition:'New',model:'250 sheets',hsn:'48101300',cost:420,price:549,tax:12,stock:20,low:4,warranty:0,supplier:'',serials:[],isSerialTracked:false},
 {id:'P004',name:'Vinyl Banner Roll 3ft',description:'PVC vinyl for outdoor banner printing, 50 metre roll',unit:'Piece',category:'Banners & vinyl',brand:'',condition:'New',model:'50m x 3ft',hsn:'39219099',cost:1800,price:2499,tax:18,stock:8,low:2,warranty:0,supplier:'',serials:[],isSerialTracked:false},
 {id:'P005',name:'Matt Lamination Film Roll',description:'Thermal matt lamination film, 300m x 320mm',unit:'Piece',category:'Labels & stickers',brand:'',condition:'New',model:'300m x 320mm',hsn:'39219099',cost:2200,price:2899,tax:18,stock:5,low:2,warranty:0,supplier:'',serials:[],isSerialTracked:false},
 {id:'P006',name:'Black Ink Cartridge',description:'Compatible black ink cartridge for desktop inkjet printers',unit:'Piece',category:'Other print products',brand:'',condition:'New',model:'',hsn:'84439935',cost:490,price:649,tax:18,stock:15,low:5,warranty:0,supplier:'',serials:[],isSerialTracked:false},
 {id:'P007',name:'Colour Ink Cartridge',description:'Compatible tri-colour ink cartridge for desktop inkjet printers',unit:'Piece',category:'Other print products',brand:'',condition:'New',model:'',hsn:'84439935',cost:590,price:779,tax:18,stock:10,low:4,warranty:0,supplier:'',serials:[],isSerialTracked:false},
 {id:'P008',name:'Spiral Binding Ring 20mm',description:'Plastic spiral binding rings, 20mm diameter, box of 100',unit:'Piece',category:'Books & stationery',brand:'',condition:'New',model:'100 pieces',hsn:'39259090',cost:150,price:199,tax:18,stock:20,low:5,warranty:0,supplier:'',serials:[],isSerialTracked:false},
 {id:'P009',name:'Hard Cover Board A4',description:'Thick board for report and book covers, pack of 100',unit:'Piece',category:'Books & stationery',brand:'',condition:'New',model:'Pack of 100',hsn:'48239090',cost:250,price:329,tax:12,stock:15,low:4,warranty:0,supplier:'',serials:[],isSerialTracked:false},
 {id:'P010',name:'Self Adhesive Label Roll 100x50mm',description:'Thermal adhesive labels on roll, 1000 labels per roll',unit:'Piece',category:'Labels & stickers',brand:'',condition:'New',model:'1000 labels',hsn:'48211090',cost:380,price:499,tax:12,stock:10,low:3,warranty:0,supplier:'',serials:[],isSerialTracked:false},
 {id:'P011',name:'Gloss Photo Paper A4 260gsm',description:'Professional photo paper for photo printers, 50 sheets',unit:'Piece',category:'Paper & sheets',brand:'',condition:'New',model:'50 sheets',hsn:'37079090',cost:180,price:249,tax:12,stock:25,low:5,warranty:0,supplier:'',serials:[],isSerialTracked:false},
 {id:'P012',name:'Foam Board A1 5mm',description:'Lightweight foam board for display and signage',unit:'Piece',category:'Frames & display materials',brand:'',condition:'New',model:'',hsn:'39211300',cost:420,price:549,tax:18,stock:10,low:3,warranty:0,supplier:'',serials:[],isSerialTracked:false},
];
export const makeLine=(id:string,qty=1,rate?:number):Line=>{const p=products.find(x=>x.id===id)!;return {productId:id,name:p.name,details:p.description||'',unit:p.unit||'Piece',printSpecifications:{},qty,rate:rate??p.price,discount:0,tax:p.tax,serials:[],hsn:p.hsn,warranty:p.warranty};};
export const seed:State={...extensionSeed,
 attachments:[],
 products,
 customers:[
 {id:'C001',name:'Ravi Stationery Mart',phone:'9000010001',email:'ravi@example.com',address:'Main Bazaar, Salem, Tamil Nadu 636001',gst:'33DEMOX1234A1Z5',type:'Business',notes:'Regular bulk paper order customer.'},
 {id:'C002',name:'Priya Event Planners',phone:'9000010002',email:'priya@example.com',address:'Fairlands, Salem, Tamil Nadu 636016',gst:'',type:'Business',notes:'Event brochures and banners.'},
 {id:'C003',name:'Kavin School',phone:'9000010003',email:'admin@kavin.example',address:'Omalur Road, Salem, Tamil Nadu 636009',gst:'33DEMOX5678A1Z6',type:'Business',notes:'Annual report and exam paper printing.'},
 {id:'C004',name:'Mohammed Trading Co',phone:'9000010004',email:'arif@example.com',address:'Suramangalam, Salem, Tamil Nadu 636005',gst:'',type:'Individual',notes:'Custom label printing.'},
 {id:'C005',name:'Lakshmi Photography',phone:'9000010005',email:'lakshmi@example.com',address:'Gugai, Salem, Tamil Nadu 636006',gst:'',type:'Business',notes:'Photo print and album services.'}],
 suppliers:[],
 bills:[
 {id:'INV-2026-0101',customerId:'C001',date:TODAY,due:TODAY,kind:'Sale',category:'New goods',status:'Issued',lines:[makeLine('P001',10),makeLine('P002',5)],inclusive:true,notes:'Bulk paper order. Thank you.',profit:null},
 {id:'INV-2026-0102',customerId:'C002',date:TODAY,due:'2026-09-20',kind:'Sale',category:'New goods',status:'Issued',lines:[makeLine('P004',2),makeLine('P012',5)],inclusive:true,notes:'Event banners and display boards.',profit:null},
 {id:'SVC-2026-0041',customerId:'C005',date:TODAY,due:TODAY,kind:'Service',category:'Service',status:'Issued',lines:[{productId:'',name:'A4 photo print batch',details:'Gloss finish, colour calibrated prints',unit:'Piece',printSpecifications:{size:'A4',material:'Gloss photo paper',gsm:'260',colour:'CMYK',sides:'Single',finishing:'Trimmed'},qty:100,rate:15,discount:0,tax:12,serials:[],hsn:'998912',warranty:0}],inclusive:true,notes:'Same-day service.',profit:null},
 {id:'INV-2026-0100',customerId:'C003',date:'2026-09-09',due:'2026-09-09',kind:'Sale',category:'New goods',status:'Issued',lines:[makeLine('P009',10),makeLine('P008',5)],inclusive:true,notes:'School project binding materials.',profit:null},
 {id:'QUO-2026-0026',customerId:'C004',date:TODAY,due:'2026-09-17',kind:'Quotation',category:'New goods',status:'Draft',lines:[makeLine('P010',5),{productId:'',name:'Custom die-cut sticker design',details:'Artwork creation and printing',unit:'Job',printSpecifications:{size:'100x50mm',material:'Vinyl',colour:'Full colour'},qty:1,rate:800,discount:0,tax:18,serials:[],hsn:'998912',warranty:0}],inclusive:true,notes:'Price valid for 7 days.',profit:null},
 {id:'QUO-2026-0025',customerId:'C002',date:'2026-09-09',due:'2026-09-16',kind:'Quotation',category:'New goods',status:'Shared',lines:[makeLine('P004',3)],inclusive:true,notes:'Includes design and grommets.',profit:null}],
 purchases:[],
 payments:[
  {id:'PAY-001',date:TODAY,direction:'In',account:'Bank account',amount:3470,purpose:'Customer payment',reference:'INV-2026-0101',party:'C001',note:'NEFT received in full'},
  {id:'PAY-002',date:TODAY,direction:'In',account:'Cash',amount:5000,purpose:'Customer payment',reference:'INV-2026-0102',party:'C002',note:'Advance against invoice'},
  {id:'PAY-003',date:TODAY,direction:'In',account:'Cash',amount:1500,purpose:'Customer payment',reference:'SVC-2026-0041',party:'C005',note:'Cash on delivery'},
  {id:'PAY-004',date:'2026-09-09',direction:'In',account:'Bank account',amount:4000,purpose:'Customer payment',reference:'INV-2026-0100',party:'C003',note:'UPI partial payment'},
  {id:'PAY-005',date:'2026-09-09',direction:'Out',account:'Bank account',amount:8000,purpose:'Operating expense',reference:'EXP-2026-0001',party:'Transport charges',note:'Delivery and transport charges'},
  {id:'PAY-006',date:TODAY,direction:'Out',account:'Bank account',amount:15000,purpose:'Operating expense',reference:'EXP-2026-0002',party:'Press maintenance',note:'Printing machine preventive maintenance'}],
 jobs:[],
 enquiries:[],
 reservations:[],
 returns:[],
 warranties:[],
 movements:[],
 closings:[],
 audit:[],
 settings:{name:'',phone:'',email:'',address:'',gst:'',state:'',stateCode:'',postalCode:'',bank:'',account:'',ifsc:'',declaration:'We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.',logo:''},
 campaigns:[]
};

// Seeded issued documents retain their original identity when master details are edited.
for(const bill of seed.bills){bill.customerSnapshot=structuredClone(seed.customers.find(c=>c.id===bill.customerId)!);bill.shopSnapshot=structuredClone(seed.settings);}
