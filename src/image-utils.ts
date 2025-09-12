import { createRequire } from 'module';
import path from 'path';
import fs from 'fs/promises';
const require = createRequire(import.meta.url);
const sharp = require('sharp');

export const SCREENSHOT_DIR = path.join('/tmp', 'devtools-debugger-mcp-screenshots');

export interface ProcessedImage {
    data: string;
    format: 'png';
    size: number;
}

export async function saveImage(processedImage: ProcessedImage): Promise<string> {
    // Ensure screenshots directory exists
    await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
    
    const filename = `screenshot_${Date.now()}.webp`;
    const filepath = path.join(SCREENSHOT_DIR, filename);
    
    // Extract the base64 data after the "data:image/webp;base64," prefix
    const base64Data = processedImage.data.split(',')[1];
    const imageBuffer = Buffer.from(base64Data, 'base64');
    
    await fs.writeFile(filepath, imageBuffer);
    return filepath;
}

export async function processImage(base64Data: string): Promise<ProcessedImage> {
    try {
        // Convert base64 to buffer
        const buffer = Buffer.from(base64Data, 'base64');
        
        // Create Sharp instance and resize maintaining aspect ratio
        const image = sharp(buffer).resize(900, 600, {
            fit: 'inside',
            withoutEnlargement: true
        });

        // Try WebP first with good quality
        try {
            const webpBuffer = await image
                .webp({
                    quality: 80,
                    effort: 6, // Higher compression effort
                    lossless: false
                })
                .toBuffer();

            if (webpBuffer.length <= 1024 * 1024) {
                return {
                    data: `data:image/webp;base64,${webpBuffer.toString('base64')}`,
                    format: 'png', // Keep format as 'png' in interface for backward compatibility
                    size: webpBuffer.length
                };
            }

            // If still too large, try WebP with more aggressive compression
            const compressedWebpBuffer = await image
                .webp({
                    quality: 60,
                    effort: 6,
                    lossless: false,
                    nearLossless: true
                })
                .toBuffer();

            if (compressedWebpBuffer.length <= 1024 * 1024) {
                return {
                    data: `data:image/webp;base64,${compressedWebpBuffer.toString('base64')}`,
                    format: 'png', // Keep format as 'png' in interface for backward compatibility
                    size: compressedWebpBuffer.length
                };
            }
        } catch (webpError) {
            console.error('WebP processing failed, falling back to PNG:', webpError);
        }

        // Fallback to PNG with compression if WebP fails or is too large
        const pngBuffer = await image
            .png({
                compressionLevel: 9,
                palette: true
            })
            .toBuffer();

        if (pngBuffer.length > 1024 * 1024) {
            // If still too large, reduce dimensions further
            const scaleFactor = Math.sqrt(1024 * 1024 / pngBuffer.length);
            const resizedImage = sharp(buffer).resize(
                Math.floor(900 * scaleFactor),
                Math.floor(600 * scaleFactor),
                {
                    fit: 'inside',
                    withoutEnlargement: true
                }
            );

            const compressedPngBuffer = await resizedImage
                .png({
                    compressionLevel: 9,
                    palette: true,
                    colors: 128 // Reduce color palette for smaller size
                })
                .toBuffer();

            if (compressedPngBuffer.length > 1024 * 1024) {
                throw new Error('Image is too large even after compression');
            }

            return {
                data: `data:image/png;base64,${compressedPngBuffer.toString('base64')}`,
                format: 'png',
                size: compressedPngBuffer.length
            };
        }

        return {
            data: `data:image/png;base64,${pngBuffer.toString('base64')}`,
            format: 'png',
            size: pngBuffer.length
        };
    } catch (error) {
        throw new Error(`Failed to process image: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}
