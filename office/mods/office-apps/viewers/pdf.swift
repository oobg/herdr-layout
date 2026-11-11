// PDF 페이지를 PNG로 렌더한다. 사용법: pdfpages <pdf> <출력 폴더> <가로 px> <최대 페이지>
// 출력(JSON 한 줄): {"count": 전체 페이지 수, "pages": [{"file": "p1.png", "w": 1200, "h": 1553}, ...]}
import Foundation
import PDFKit
import AppKit

let a = CommandLine.arguments
guard a.count >= 5, let doc = PDFDocument(url: URL(fileURLWithPath: a[1])) else { print("{\"error\":\"open\"}"); exit(1) }
let out = a[2], width = CGFloat(Double(a[3]) ?? 1200), limit = Int(a[4]) ?? 30
try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
var pages: [String] = []
for i in 0..<min(doc.pageCount, limit) {
    guard let page = doc.page(at: i) else { continue }
    let box = page.bounds(for: .mediaBox)
    let scale = width / box.width
    let size = NSSize(width: box.width * scale, height: box.height * scale)
    let img = page.thumbnail(of: size, for: .mediaBox)
    guard let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: .png, properties: [:]) else { continue }
    let name = "p\(i + 1).png"
    try? png.write(to: URL(fileURLWithPath: "\(out)/\(name)"))
    pages.append("{\"file\":\"\(name)\",\"w\":\(rep.pixelsWide),\"h\":\(rep.pixelsHigh)}")
}
print("{\"count\":\(doc.pageCount),\"pages\":[\(pages.joined(separator: ","))]}")
